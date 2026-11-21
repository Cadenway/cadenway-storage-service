import { SaxesParser, type SaxesTagNS } from 'saxes';

import { ProfileMediaError } from '../../../domain/errors/media/profile-media.error.js';
import {
  MAX_PROFILE_MEDIA_DERIVATIVE_SIDE,
  MAX_PROFILE_MEDIA_SOURCE_SIDE,
} from '../../../domain/policies/media/profile-media-verification.policy.js';

const namespace = 'http://www.w3.org/2000/svg';
const maximumElements = 1_024;
const maximumDepth = 12;
const maximumGeometry = 256 * 1024;
const maximumCoordinate = 65_536;
const numberSyntax = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/gu;
const pureNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const pathSyntax = /^[MmZzLlHhVvCcSsQqTtAa\d\s.,+eE-]+$/u;
const pointSyntax = /^[\d\s.,+eE-]+$/u;

const shapeAttributes = new Map<string, readonly string[]>([
  ['g', []],
  ['path', ['d']],
  ['rect', ['x', 'y', 'width', 'height', 'rx', 'ry']],
  ['circle', ['cx', 'cy', 'r']],
  ['ellipse', ['cx', 'cy', 'rx', 'ry']],
  ['line', ['x1', 'y1', 'x2', 'y2']],
  ['polygon', ['points']],
  ['polyline', ['points']],
]);

function invalidSvg(): never {
  throw new ProfileMediaError('invalid-image');
}

function number(value: string, limit: number, minimum = -limit): number {
  if (value.length > 32 || !pureNumber.test(value)) return invalidSvg();
  const coordinate = Number(value);
  if (!(coordinate >= minimum && coordinate <= limit)) return invalidSvg();
  return coordinate;
}

function coordinates(value: string): readonly number[] {
  if (value.length > 256) return invalidSvg();
  return value
    .trim()
    .split(/[\s,]+/u)
    .map((coordinate) => number(coordinate, maximumCoordinate));
}

function vector(value: string, syntax: RegExp): void {
  if (!syntax.test(value)) return invalidSvg();
  for (const [coordinate] of value.matchAll(numberSyntax)) number(coordinate, maximumCoordinate);
}

function transform(value: string): void {
  if (value.length > 256) return invalidSvg();
  const transforms = value.trim();
  const entries = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)[\s,]*/guy;
  let count = 0;
  let cursor = 0;
  for (const entry of transforms.matchAll(entries)) {
    const [, name, argumentsText] = entry;
    if (name === undefined || argumentsText === undefined) return invalidSvg();
    const args = coordinates(argumentsText);
    const length = args.length;
    switch (name) {
      case 'matrix':
        if (length !== 6 || args.slice(0, 4).some((item) => Math.abs(item) > 16)) {
          return invalidSvg();
        }
        break;
      case 'translate':
        if (length > 2) return invalidSvg();
        break;
      case 'scale':
        if (length > 2 || args.some((item) => Math.abs(item) > 16)) return invalidSvg();
        break;
      case 'rotate':
        if (length !== 1 && length !== 3) return invalidSvg();
        break;
      default:
        if (length !== 1 || args.some((item) => Math.abs(item) > 80)) return invalidSvg();
    }
    cursor = entry.index + entry[0].length;
    count++;
  }
  if (cursor !== transforms.length || count < 1 || count > 4) return invalidSvg();
}

function presentation(name: string, value: string): void {
  switch (name) {
    case 'fill':
    case 'stroke':
      if (!/^(?:#[a-f\d]{3}|#[a-f\d]{4}|#[a-f\d]{6}|#[a-f\d]{8}|[a-z]{1,24})$/iu.test(value)) {
        return invalidSvg();
      }
      break;
    case 'fill-rule':
      if (value !== 'nonzero' && value !== 'evenodd') return invalidSvg();
      break;
    case 'opacity':
    case 'fill-opacity':
    case 'stroke-opacity':
      number(value, 1, 0);
      break;
    case 'stroke-width':
      number(value, MAX_PROFILE_MEDIA_SOURCE_SIDE, 0);
      break;
    case 'stroke-miterlimit':
      number(value, 64, 1);
      break;
    case 'stroke-linecap':
      if (value !== 'butt' && value !== 'round' && value !== 'square') return invalidSvg();
      break;
    case 'stroke-linejoin':
      if (value !== 'miter' && value !== 'round' && value !== 'bevel') return invalidSvg();
      break;
    default:
      return invalidSvg();
  }
}

function shapeValue(name: string, value: string, allowed: readonly string[]): void {
  if (name === 'transform') {
    transform(value);
  } else if (!allowed.includes(name)) {
    presentation(name, value);
  } else if (name === 'd') {
    vector(value, pathSyntax);
  } else if (name === 'points') {
    vector(value, pointSyntax);
  } else {
    number(value, maximumCoordinate);
  }
}

function rootSize(attributes: ReadonlyMap<string, string>): {
  readonly size: number;
  readonly viewBox: string;
} {
  const declaredViewBox = attributes.get('viewBox');
  const parts = declaredViewBox === undefined ? [] : coordinates(declaredViewBox);
  if (declaredViewBox !== undefined && parts.length !== 4) return invalidSvg();
  const [, , viewWidth, viewHeight] = parts;
  if (viewWidth !== undefined && viewWidth < 1) return invalidSvg();
  if (viewHeight !== undefined && viewHeight < 1) return invalidSvg();
  const widthAttribute = attributes.get('width');
  const heightAttribute = attributes.get('height');
  if ((widthAttribute === undefined) !== (heightAttribute === undefined)) return invalidSvg();
  const width =
    widthAttribute === undefined
      ? viewWidth
      : number(widthAttribute.replace(/px$/u, ''), MAX_PROFILE_MEDIA_SOURCE_SIDE, 1);
  const height =
    heightAttribute === undefined
      ? viewHeight
      : number(heightAttribute.replace(/px$/u, ''), MAX_PROFILE_MEDIA_SOURCE_SIDE, 1);
  if (
    width === undefined ||
    !Number.isInteger(width) ||
    width < 1 ||
    width > MAX_PROFILE_MEDIA_SOURCE_SIDE ||
    width !== height
  ) {
    return invalidSvg();
  }
  return { size: width, viewBox: (parts.length === 0 ? [0, 0, width, width] : parts).join(' ') };
}

function svgAttributes(tag: SaxesTagNS, root: boolean): Map<string, string> {
  if (tag.prefix !== '' || (tag.uri !== '' && tag.uri !== namespace)) return invalidSvg();
  const attributes = new Map<string, string>();
  for (const attribute of Object.values(tag.attributes)) {
    if (root && attribute.name === 'xmlns' && attribute.value === namespace) continue;
    if (attribute.prefix !== '' || attribute.uri !== '' || attribute.name === 'xmlns') {
      return invalidSvg();
    }
    attributes.set(attribute.name, attribute.value.trim());
  }
  return attributes;
}

/** Rebuilds static geometry as an SVG with no URLs, XML directives, CSS, filters or text. */
export function sanitizeProfileSvg(bytes: Buffer): {
  readonly svg: Buffer;
  readonly sourceSide: number;
} {
  const output: string[] = [];
  const elements: string[] = [];
  let sourceSide = 0;
  let elementsSeen = 0;
  let geometrySize = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', invalidSvg);
  parser.on('doctype', invalidSvg);
  parser.on('processinginstruction', invalidSvg);
  parser.on('cdata', invalidSvg);
  parser.on('text', (value) => {
    if (value.trim() !== '') invalidSvg();
  });
  parser.on('opentag', (tag) => {
    elementsSeen++;
    if (elementsSeen > maximumElements || elements.length >= maximumDepth) return invalidSvg();
    const root = elements.length === 0;
    const attributes = svgAttributes(tag, root);
    let fragment: string;
    if (root) {
      if (tag.local !== 'svg') return invalidSvg();
      const { size, viewBox } = rootSize(attributes);
      const outputSide = String(Math.min(size, MAX_PROFILE_MEDIA_DERIVATIVE_SIDE));
      sourceSide = size;
      attributes.delete('viewBox');
      attributes.delete('width');
      attributes.delete('height');
      const version = attributes.get('version');
      if (version !== undefined && version !== '1.0' && version !== '1.1') return invalidSvg();
      attributes.delete('version');
      fragment = `<svg xmlns="${namespace}" width="${outputSide}" height="${outputSide}" viewBox="${viewBox}"`;
      for (const [name, value] of attributes) {
        presentation(name, value);
        fragment += ` ${name}="${value}"`;
      }
    } else {
      const parent = elements.at(-1);
      const allowed = shapeAttributes.get(tag.local);
      if (allowed === undefined || (parent !== 'svg' && parent !== 'g')) return invalidSvg();
      fragment = `<${tag.local}`;
      for (const [name, value] of attributes) {
        geometrySize += value.length;
        if (geometrySize > maximumGeometry) return invalidSvg();
        shapeValue(name, value, allowed);
        fragment += ` ${name}="${value}"`;
      }
    }
    elements.push(tag.local);
    output.push(`${fragment}>`);
  });
  parser.on('closetag', () => {
    const name = elements.pop();
    if (name === undefined) return invalidSvg();
    output.push(`</${name}>`);
  });
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close();
  if (sourceSide === 0) return invalidSvg();
  return { svg: Buffer.from(output.join(''), 'utf-8'), sourceSide };
}
