import sharp, { type Sharp } from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  ProfileMediaImageProcessingBusyError,
  ProfileMediaImageProcessor,
} from './profile-media-image-processor.adapter.js';

const candidateId = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01';

function canvas(width: number, height = width): Sharp {
  return sharp({ create: { width, height, channels: 3, background: '#31578c' } });
}

function logo(bytes: Buffer): Parameters<ProfileMediaImageProcessor['transform']>[0] {
  return { kind: 'organization-logo', contentType: 'image/svg+xml', candidateId, bytes };
}

describe('ProfileMediaImageProcessor', () => {
  it.each(['jpeg', 'webp', 'png'] as const)(
    'decodes one square %s avatar and writes only metadata-free PNG pixels',
    async (format) => {
      const bytes = await canvas(640).withMetadata({ density: 120 }).toFormat(format).toBuffer();
      const processor = new ProfileMediaImageProcessor();
      const contentType = `image/${format}`;
      const result = await processor.transform({ kind: 'avatar', contentType, bytes, candidateId });

      expect(result.verification).toEqual({
        candidateId,
        source: { contentType, sizeBytes: bytes.length, width: 640, height: 640, frames: 1 },
        derivative: {
          contentType: 'image/png',
          width: 512,
          height: 512,
          sizeBytes: result.png.length,
          metadataFree: true,
        },
      });
      const output = await sharp(result.png).metadata();
      expect(output).toMatchObject({ format: 'png', width: 512, height: 512, hasProfile: false });
      expect(output.exif).toBeUndefined();
      expect(result.png.includes('pHYs')).toBe(false);
    },
  );

  it('rasterizes ordinary SVG geometry at the output bound and keeps the source extent', async () => {
    const bytes = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200">' +
        '<g transform="translate(12 12)"><path d="M0 0 H1176 V1176 H0 Z" fill="#31578c"/></g></svg>',
    );
    const result = await new ProfileMediaImageProcessor().transform(logo(bytes));
    expect(result.verification.source).toMatchObject({
      sizeBytes: bytes.length,
      width: 1200,
      height: 1200,
      frames: 1,
      selfContainedSvg: true,
    });
    const raster = await sharp(result.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(raster.info).toMatchObject({ width: 512, height: 512, channels: 4 });
    const sampleOffset = (256 * raster.info.width + 256) * raster.info.channels;
    expect([...raster.data.subarray(sampleOffset, sampleOffset + 4)]).toEqual([49, 87, 140, 255]);
  });

  it('does not upscale a smaller square logo', async () => {
    const bytes = await canvas(40).png().toBuffer();
    const result = await new ProfileMediaImageProcessor().transform({
      kind: 'organization-logo',
      contentType: 'image/png',
      bytes,
      candidateId,
    });
    expect(result.verification.derivative).toMatchObject({ width: 40, height: 40 });
  });

  it('refuses a non-square image, an avatar below the minimum, and an oversized buffer', async () => {
    const processor = new ProfileMediaImageProcessor();
    const input = { kind: 'avatar', contentType: 'image/png', candidateId } as const;
    await expect(
      processor.transform({ ...input, bytes: await canvas(256, 257).png().toBuffer() }),
    ).rejects.toMatchObject({ reason: 'invalid-image' });
    await expect(
      processor.transform({ ...input, bytes: await canvas(255).png().toBuffer() }),
    ).rejects.toMatchObject({ reason: 'invalid-image' });
    await expect(
      processor.transform({ ...input, bytes: Buffer.alloc(5 * 1024 * 1024 + 1) }),
    ).rejects.toMatchObject({ reason: 'file-too-large' });
  });

  it('refuses a staged file whose bytes do not match its supported declaration', async () => {
    const bytes = await canvas(256).jpeg().toBuffer();
    const input = { kind: 'avatar', contentType: 'image/png', candidateId } as const;
    await expect(
      new ProfileMediaImageProcessor().transform({ ...input, bytes }),
    ).rejects.toMatchObject({
      reason: 'invalid-image',
    });
  });

  it('refuses an animated WebP even when each frame is a valid avatar', async () => {
    const frameLength = 256 * 256 * 3;
    const bytes = await sharp(
      Buffer.concat([Buffer.alloc(frameLength, 64), Buffer.alloc(frameLength, 192)]),
      {
        raw: { width: 256, height: 512, pageHeight: 256, channels: 3 },
      },
    )
      .webp({ delay: [100, 100] })
      .toBuffer();
    const metadata = await sharp(bytes, { animated: true }).metadata();
    expect(metadata.pages).toBe(2);
    await expect(
      new ProfileMediaImageProcessor().transform({
        kind: 'avatar',
        contentType: 'image/webp',
        bytes,
        candidateId,
      }),
    ).rejects.toMatchObject({ reason: 'invalid-image' });
  });

  it('refuses PNG animation control chunks before an image decoder can flatten them', async () => {
    const staticPng = await canvas(256).png().toBuffer();
    const chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(8, 0);
    chunk.write('acTL', 4, 'ascii');
    chunk.writeUInt32BE(2, 8);
    const bytes = Buffer.concat([staticPng.subarray(0, 33), chunk, staticPng.subarray(33)]);
    await expect(
      new ProfileMediaImageProcessor().transform({
        kind: 'avatar',
        contentType: 'image/png',
        bytes,
        candidateId,
      }),
    ).rejects.toMatchObject({ reason: 'invalid-image' });
  });

  it.each([
    '<!DOCTYPE svg><svg viewBox="0 0 12 12"/>',
    '<svg viewBox="0 0 12 12"><image href="logo.png" /></svg>',
    '<svg viewBox="0 0 12 12"><rect width="12" height="12" fill="url(#paint)" /></svg>',
    '<svg viewBox="0 0 12 12"><rect width="12" height="12" filter="none" /></svg>',
    '<svg viewBox="0 0 5000 5000"><path d="M0 0 Z"/></svg>',
  ])('refuses drawings outside the static safe vector subset', async (source) => {
    await expect(
      new ProfileMediaImageProcessor().transform(logo(Buffer.from(source))),
    ).rejects.toMatchObject({ reason: 'invalid-image' });
  });

  it('refuses concurrent native work and releases capacity after processing', async () => {
    const processor = new ProfileMediaImageProcessor();
    const input = logo(Buffer.from('<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4"/></svg>'));
    const pending = processor.transform(input);
    await expect(processor.transform(input)).rejects.toBeInstanceOf(
      ProfileMediaImageProcessingBusyError,
    );
    await expect(pending).resolves.toMatchObject({ verification: { derivative: { width: 12 } } });
    await expect(processor.transform(input)).resolves.toMatchObject({
      verification: { derivative: { width: 12 } },
    });
  });
});
