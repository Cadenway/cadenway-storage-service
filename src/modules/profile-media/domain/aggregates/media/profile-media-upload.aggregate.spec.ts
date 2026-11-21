import { describe, expect, it } from 'vitest';

import type { ProfileMediaTransfer } from '../../value-objects/media/profile-media-transfer.value-object.js';
import type { ProfileMediaVerification } from '../../value-objects/media/profile-media-verification.value-object.js';
import { ProfileMediaUpload } from './profile-media-upload.aggregate.js';

const NOW = new Date('2026-11-20T09:00:00Z');
const EXPIRY = new Date('2026-11-20T09:05:00Z');
const CAMILLE = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30';
const ATELIER_NORD = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const UPLOAD = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01';
const CANDIDATE = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b02';
const OTHER_CANDIDATE = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b03';
const AVATAR = { kind: 'avatar', id: CAMILLE } as const;
const LOGO = { kind: 'organization-logo', id: ATELIER_NORD } as const;

function transfer(overrides: Partial<ProfileMediaTransfer> = {}): ProfileMediaTransfer {
  return {
    owner: AVATAR,
    uploadId: UPLOAD,
    uploaderUserId: CAMILLE,
    contentType: 'image/webp',
    sizeBytes: 43_024,
    expiresAt: new Date(EXPIRY),
    ...overrides,
  };
}

function proof(
  source: Partial<ProfileMediaVerification['source']> = {},
  derivative: Partial<ProfileMediaVerification['derivative']> = {},
): ProfileMediaVerification {
  return {
    candidateId: CANDIDATE,
    source: {
      contentType: 'image/webp',
      sizeBytes: 43_024,
      width: 1024,
      height: 1024,
      frames: 1,
      ...source,
    },
    derivative: {
      contentType: 'image/png',
      width: 512,
      height: 512,
      sizeBytes: 41_632,
      metadataFree: true,
      ...derivative,
    },
  };
}

describe('ProfileMediaUpload', () => {
  it('binds an avatar reservation to the account and canonical UUIDv7', () => {
    const input = transfer({
      owner: { kind: 'avatar', id: CAMILLE.toUpperCase() },
      uploaderUserId: CAMILLE.toUpperCase(),
      uploadId: UPLOAD.toUpperCase(),
    });
    const upload = ProfileMediaUpload.reserve(input, NOW);
    expect(upload.snapshot).toMatchObject({
      owner: AVATAR,
      uploadId: UPLOAD,
      status: 'pending',
      declaration: { uploaderUserId: CAMILLE, expiresAt: EXPIRY },
    });
    expect(() => {
      upload.assertEquivalent(transfer());
    }).not.toThrow();
    expect(() =>
      ProfileMediaUpload.reserve(transfer({ uploaderUserId: ATELIER_NORD }), NOW),
    ).toThrow(expect.objectContaining({ reason: 'not-found' }));
    expect(() => ProfileMediaUpload.reserve(transfer({ uploadId: 'invalid' }), NOW)).toThrow(
      expect.objectContaining({ reason: 'invalid-identity' }),
    );
  });

  it('keeps the logo uploader separate from the organization owner', () => {
    const upload = ProfileMediaUpload.reserve(
      transfer({ owner: LOGO, contentType: 'image/png' }),
      NOW,
    );
    expect(() => {
      upload.assertUploader(LOGO, CAMILLE);
    }).not.toThrow();
    expect(() => {
      upload.assertUploader(LOGO, ATELIER_NORD);
    }).toThrow(expect.objectContaining({ reason: 'not-found' }));
    expect(() => {
      upload.assertUploader(AVATAR, CAMILLE);
    }).toThrow(expect.objectContaining({ reason: 'not-found' }));
  });

  it('keeps the original deadline for an equivalent signed receipt and rejects unsigned expiry', () => {
    const input = transfer();
    const upload = ProfileMediaUpload.reserve(input, NOW);
    expect(() => {
      upload.requireSignable(EXPIRY, true);
    }).not.toThrow();
    expect(() => {
      upload.requireSignable(EXPIRY, false);
    }).toThrow(expect.objectContaining({ reason: 'upload-expired' }));
    expect(() => {
      upload.assertEquivalent(transfer({ expiresAt: new Date(EXPIRY.getTime() + 1) }));
    }).toThrow(expect.objectContaining({ reason: 'key-reused' }));
    expect(() => ProfileMediaUpload.reserve(transfer(), EXPIRY)).toThrow(
      expect.objectContaining({ reason: 'upload-expired' }),
    );
    expect(() =>
      ProfileMediaUpload.reserve(transfer({ expiresAt: new Date(EXPIRY.getTime() + 1) }), NOW),
    ).toThrow(expect.objectContaining({ reason: 'invalid-state' }));
  });

  it('detaches mutable dates from the declaration and restored snapshots', () => {
    const input = transfer();
    const upload = ProfileMediaUpload.reserve(input, NOW);
    input.expiresAt.setTime(0);
    upload.snapshot.declaration?.expiresAt.setTime(1);
    const restored = ProfileMediaUpload.restore(upload.snapshot);
    expect(restored.snapshot.declaration?.expiresAt).toEqual(EXPIRY);
  });

  it.each([
    ['image/svg+xml', 100, 'unsupported-type'],
    ['image/webp', 5_242_881, 'file-too-large'],
    ['image/png', 0, 'invalid-image'],
  ] as const)('refuses a declaration of %s and %i bytes', (contentType, sizeBytes, reason) => {
    expect(() => ProfileMediaUpload.reserve(transfer({ contentType, sizeBytes }), NOW)).toThrow(
      expect.objectContaining({ reason }),
    );
  });

  it.each([
    { width: 4097, height: 4097 },
    { width: 255, height: 255 },
    { height: 768 },
    { frames: 2 },
    { sizeBytes: 43_023 },
    { contentType: 'image/png' },
  ] satisfies readonly Partial<ProfileMediaVerification['source']>[])(
    'rejects a mismatched, animated, oversized or non-square source %o',
    (source) => {
      const upload = ProfileMediaUpload.reserve(transfer(), NOW);
      expect(() => upload.prepare(proof(source), NOW)).toThrow(
        expect.objectContaining({ reason: 'invalid-image' }),
      );
    },
  );

  it('requires a self-contained SVG logo and never upscales a source', () => {
    const upload = ProfileMediaUpload.reserve(
      transfer({ owner: LOGO, contentType: 'image/svg+xml' }),
      NOW,
    );
    const source = { contentType: 'image/svg+xml', width: 128, height: 128 };
    expect(() => upload.prepare(proof(source, { width: 128, height: 128 }), NOW)).toThrow(
      expect.objectContaining({ reason: 'invalid-image' }),
    );
    expect(() => upload.prepare(proof({ ...source, selfContainedSvg: true }), NOW)).toThrow(
      expect.objectContaining({ reason: 'invalid-image' }),
    );
    expect(
      upload
        .prepare(proof({ ...source, selfContainedSvg: true }, { width: 128, height: 128 }), NOW)
        .getPreparation(),
    ).toMatchObject({ width: 128, height: 128, contentType: 'image/png' });
  });

  it.each([
    { contentType: 'image/webp' },
    { width: 513, height: 513 },
    { width: 511 },
    { metadataFree: false },
  ] satisfies readonly Partial<ProfileMediaVerification['derivative']>[])(
    'rejects a candidate that is not a bounded metadata-free square PNG %o',
    (candidate) => {
      const upload = ProfileMediaUpload.reserve(transfer(), NOW);
      expect(() => upload.prepare(proof({}, candidate), NOW)).toThrow(
        expect.objectContaining({ reason: 'invalid-image' }),
      );
    },
  );

  it('keeps the first verified candidate through replay and exposes only verified public metadata', () => {
    const upload = ProfileMediaUpload.reserve(transfer(), NOW);
    expect(upload.getPreparation()).toBeNull();
    expect(() => upload.prepare(proof(), EXPIRY)).toThrow(
      expect.objectContaining({ reason: 'upload-expired' }),
    );
    const pinned = upload.prepare(proof(), NOW);
    expect(() => {
      pinned.requireSignable(NOW, false);
    }).toThrow(expect.objectContaining({ reason: 'invalid-state' }));
    expect(pinned.prepare({ ...proof(), candidateId: OTHER_CANDIDATE }, EXPIRY)).toBe(pinned);
    expect(pinned.getPreparation()).toEqual({
      uploadId: UPLOAD,
      contentType: 'image/png',
      width: 512,
      height: 512,
      sizeBytes: 41_632,
    });
    expect(pinned.readDerivative(AVATAR, UPLOAD)).toMatchObject({ candidateId: CANDIDATE });
    expect(() => pinned.readDerivative(LOGO, UPLOAD)).toThrow(
      expect.objectContaining({ reason: 'not-found' }),
    );
    expect(() => pinned.readDerivative(AVATAR, CANDIDATE)).toThrow(
      expect.objectContaining({ reason: 'not-found' }),
    );
    expect(() => upload.adopt()).toThrow(expect.objectContaining({ reason: 'upload-not-ready' }));
    const adopted = pinned.adopt();
    expect(adopted.snapshot.status).toBe('attached');
    expect(adopted.adopt()).toBe(adopted);
  });

  it('fences an abandoned upload before reservation and a replaced immutable derivative', () => {
    const fenced = ProfileMediaUpload.retired(AVATAR, UPLOAD);
    expect(fenced.retire()).toBe(fenced);
    expect(() => fenced.prepare(proof(), NOW)).toThrow(
      expect.objectContaining({ reason: 'upload-superseded' }),
    );
    expect(() => {
      fenced.requireSignable(NOW, true);
    }).toThrow(expect.objectContaining({ reason: 'not-found' }));
    expect(() => {
      fenced.assertEquivalent(transfer());
    }).toThrow(expect.objectContaining({ reason: 'not-found' }));
    const retired = ProfileMediaUpload.reserve(transfer(), NOW)
      .prepare(proof(), NOW)
      .adopt()
      .retire();
    expect(retired.snapshot.derivative).toMatchObject({ candidateId: CANDIDATE });
    expect(retired.getPreparation()).toBeNull();
    expect(() => {
      retired.requireSignable(EXPIRY, true);
    }).not.toThrow();
    expect(() => {
      retired.requireSignable(EXPIRY, false);
    }).toThrow(expect.objectContaining({ reason: 'not-found' }));
    expect(() => retired.readDerivative(AVATAR, UPLOAD)).toThrow(
      expect.objectContaining({ reason: 'not-found' }),
    );
    expect(() => retired.adopt()).toThrow(expect.objectContaining({ reason: 'upload-superseded' }));
  });
});
