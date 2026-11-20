import { ProfileMediaError } from '../../../domain/errors/media/profile-media.error.js';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const imageChunks = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS']);
const animationChunks = new Set(['acTL', 'fcTL', 'fdAT']);
const pngChunkName = /^[a-z]{4}$/iu;
const maximumChunks = 8_192;

function invalidPng(): never {
  throw new ProfileMediaError('invalid-image');
}

/** Keeps the pixel-bearing PNG chunks, rejects animation, and reads the declared pixel extent. */
export function profilePng(bytes: Buffer): {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
} {
  if (!bytes.subarray(0, signature.length).equals(signature)) return invalidPng();

  const chunks: Buffer[] = [signature];
  let offset = signature.length;
  let width = 0;
  let height = 0;
  let count = 0;
  let foundImageData = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + size + 12;
    const name = bytes.toString('latin1', offset + 4, offset + 8);
    count++;
    if (end > bytes.length || count > maximumChunks || !pngChunkName.test(name)) {
      return invalidPng();
    }
    if (count === 1) {
      if (name !== 'IHDR' || size !== 13) return invalidPng();
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
    } else if (name === 'IHDR' || animationChunks.has(name)) {
      return invalidPng();
    }
    if (imageChunks.has(name)) {
      chunks.push(bytes.subarray(offset, end));
    } else if (/^[A-Z]/u.test(name)) {
      return invalidPng();
    }
    if (name === 'IDAT') foundImageData = true;
    if (name === 'IEND') {
      if (!foundImageData || size !== 0 || end !== bytes.length) return invalidPng();
      const image = chunks.length === count + 1 ? bytes : Buffer.concat(chunks);
      return { bytes: image, width, height };
    }
    offset = end;
  }
  return invalidPng();
}
