import { describe, expect, it, vi } from 'vitest';

import { ProfileMediaOwner } from '../../../../../domain/aggregates/media/profile-media-owner.aggregate.js';
import type { ProfileMediaUpload } from '../../../../../domain/aggregates/media/profile-media-upload.aggregate.js';
import type { ProfileMediaTransaction } from '../../../../models/media/profile-media-transaction.model.js';
import type { ProfileMediaObjects } from '../../../../ports/outbound/object-storage/media/profile-media-objects.port.js';
import type { ProfileMediaImageProcessor } from '../../../../ports/outbound/image-processing/media/profile-media-image-processor.port.js';
import { AbandonProfileMedia } from '../abandon-profile-media/abandon-profile-media.use-case.js';
import { SignProfileMediaTransfer } from '../sign-profile-media-transfer/sign-profile-media-transfer.use-case.js';
import { ReadProfileMedia } from '../../../queries/media/read-profile-media/read-profile-media.use-case.js';
import { PrepareProfileMedia } from './prepare-profile-media.use-case.js';

const owner = { kind: 'avatar', id: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30' } as const;
const uploadId = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01';
const candidateId = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b02';
const now = new Date('2026-11-20T09:00:00Z');
const declaration = {
  owner,
  uploadId,
  uploaderUserId: owner.id,
  contentType: 'image/webp',
  sizeBytes: 10,
  expiresAt: new Date('2026-11-20T09:05:00Z'),
};
const capability = {
  uploadId,
  method: 'POST' as const,
  url: 'https://storage.example.test/upload',
  fields: { key: 'opaque' },
  expiresAt: declaration.expiresAt.toISOString(),
};
const png = Buffer.from('png');
const verification = {
  candidateId,
  source: { contentType: 'image/webp', sizeBytes: 10, width: 256, height: 256, frames: 1 },
  derivative: {
    contentType: 'image/png',
    sizeBytes: png.length,
    width: 256,
    height: 256,
    metadataFree: true,
  },
};

function fixture() {
  let ownerState = ProfileMediaOwner.empty(owner);
  let upload: ProfileMediaUpload | null = null;
  let storedCapability: typeof capability | null = null;
  const store = {
    lockOwner: vi.fn().mockImplementation(() => Promise.resolve(ownerState)),
    lockUpload: vi.fn().mockImplementation(() => Promise.resolve(upload)),
    insertUpload: vi.fn().mockImplementation((value: ProfileMediaUpload) => {
      upload = value;
      return Promise.resolve();
    }),
    saveUpload: vi.fn().mockImplementation((value: ProfileMediaUpload) => {
      upload = value;
      return Promise.resolve();
    }),
    saveOwner: vi.fn().mockImplementation((value: ProfileMediaOwner) => {
      ownerState = value;
      return Promise.resolve();
    }),
    findCapability: vi.fn().mockImplementation(() => Promise.resolve(storedCapability)),
    claimSigning: vi.fn().mockResolvedValue('lease'),
    completeSigning: vi
      .fn()
      .mockImplementation((_owner, _upload, _lease, value: typeof capability) => {
        storedCapability = value;
        return Promise.resolve(true);
      }),
    releaseSigning: vi.fn().mockResolvedValue(undefined),
    registerCandidate: vi.fn().mockResolvedValue(undefined),
    electCandidate: vi.fn().mockImplementation((value: ProfileMediaUpload) => {
      upload = value;
      return Promise.resolve(true);
    }),
    scheduleCleanup: vi.fn().mockResolvedValue(undefined),
    scheduleOwnerCleanup: vi.fn().mockResolvedValue(undefined),
  } satisfies ProfileMediaTransaction;
  const work = {
    run: <T>(_owner: typeof owner, fn: (transaction: ProfileMediaTransaction) => Promise<T>) =>
      fn(store),
  };
  const objects = {
    sign: vi.fn().mockResolvedValue(capability),
    readSource: vi.fn().mockResolvedValue(Buffer.alloc(10)),
    putCandidate: vi.fn().mockResolvedValue(undefined),
    readCandidate: vi.fn().mockResolvedValue(png),
  } satisfies ProfileMediaObjects;
  const processor = {
    transform: vi.fn().mockResolvedValue({ png, verification }),
  } satisfies ProfileMediaImageProcessor;
  const runtime = {
    now: vi.fn().mockReturnValue(now),
    newId: vi.fn().mockResolvedValue(candidateId),
  };
  return { store, work, objects, processor, runtime };
}

describe('profile media operations', () => {
  it('refuses an equivalent allocation with an active signing lease before a duplicate transfer', async () => {
    const { store, work, objects, runtime } = fixture();
    store.claimSigning.mockResolvedValueOnce(null);
    const useCase = new SignProfileMediaTransfer(work, objects, runtime);

    await expect(useCase.execute(declaration)).rejects.toMatchObject({
      reason: 'request-in-progress',
    });
    expect(objects.sign).not.toHaveBeenCalled();
  });

  it('replays the original signed capability after expiry without signing again', async () => {
    const { work, objects, runtime } = fixture();
    const useCase = new SignProfileMediaTransfer(work, objects, runtime);
    expect(await useCase.execute(declaration)).toEqual({ capability });
    runtime.now.mockReturnValue(new Date('2026-11-20T10:00:00Z'));
    await new AbandonProfileMedia(work).execute(declaration);
    expect(await useCase.execute(declaration)).toEqual({ capability });
    expect(objects.sign).toHaveBeenCalledOnce();
  });

  it('registers a candidate before external writes and keeps the accepted preparation on replay', async () => {
    const { store, work, objects, processor, runtime } = fixture();
    await new SignProfileMediaTransfer(work, objects, runtime).execute(declaration);
    const useCase = new PrepareProfileMedia(work, objects, processor, runtime);
    const first = await useCase.execute(declaration);
    expect(first.preparation).toEqual({
      uploadId,
      contentType: 'image/png',
      width: 256,
      height: 256,
      sizeBytes: 3,
    });
    expect(objects.readSource).toHaveBeenCalledWith(
      { owner, uploadId, contentType: declaration.contentType, sizeBytes: declaration.sizeBytes },
      undefined,
    );
    expect(store.registerCandidate.mock.invocationCallOrder[0]).toBeLessThan(
      objects.putCandidate.mock.invocationCallOrder[0] ?? 0,
    );
    runtime.now.mockReturnValue(new Date('2026-11-20T10:00:00Z'));
    expect(await useCase.execute(declaration)).toEqual(first);
    expect(objects.putCandidate).toHaveBeenCalledOnce();
  });

  it('bounds source reads and candidate reservations and releases the permit after a failure', async () => {
    const { store, work, objects, processor, runtime } = fixture();
    await new SignProfileMediaTransfer(work, objects, runtime).execute(declaration);
    const useCase = new PrepareProfileMedia(work, objects, processor, runtime);
    let finishFirstSource: (value: Buffer | null) => void = () => undefined;
    const firstSource = new Promise<Buffer | null>((resolve) => {
      finishFirstSource = resolve;
    });
    objects.readSource.mockReturnValueOnce(firstSource);
    const first = expect(useCase.execute(declaration)).rejects.toMatchObject({
      reason: 'upload-not-ready',
    });
    await vi.waitFor(() => {
      expect(objects.readSource).toHaveBeenCalledOnce();
    });
    try {
      await expect(useCase.execute(declaration)).rejects.toMatchObject({
        name: 'ProfileMediaUnavailable',
      });
      expect(store.registerCandidate).toHaveBeenCalledOnce();
      expect(objects.readSource).toHaveBeenCalledOnce();
    } finally {
      finishFirstSource(null);
    }
    await first;
    await expect(useCase.execute(declaration)).resolves.toMatchObject({
      preparation: { uploadId },
    });
  });

  it('never returns an image retired while the object read was pending', async () => {
    const { work, objects, processor, runtime } = fixture();
    await new SignProfileMediaTransfer(work, objects, runtime).execute(declaration);
    await new PrepareProfileMedia(work, objects, processor, runtime).execute(declaration);
    objects.readCandidate.mockImplementation(async () => {
      await new AbandonProfileMedia(work).execute(declaration);
      return png;
    });
    await expect(
      new ReadProfileMedia(work, objects).execute({ owner, assetId: uploadId }),
    ).rejects.toMatchObject({ reason: 'not-found' });
  });

  it('rejects an abandoned reservation arriving before the signing request', async () => {
    const { work, objects, runtime } = fixture();
    await new AbandonProfileMedia(work).execute(declaration);
    await expect(
      new SignProfileMediaTransfer(work, objects, runtime).execute(declaration),
    ).rejects.toMatchObject({ reason: 'not-found' });
    expect(objects.sign).not.toHaveBeenCalled();
  });

  it('checks the retired declaration before replay and never renews a missing receipt', async () => {
    const { work, objects, runtime, store } = fixture();
    const useCase = new SignProfileMediaTransfer(work, objects, runtime);
    await useCase.execute(declaration);
    await new AbandonProfileMedia(work).execute(declaration);
    store.findCapability.mockClear();
    await expect(useCase.execute({ ...declaration, sizeBytes: 11 })).rejects.toMatchObject({
      reason: 'key-reused',
    });
    expect(store.findCapability).not.toHaveBeenCalled();

    store.findCapability.mockResolvedValueOnce(null);
    runtime.now.mockReturnValue(new Date('2026-11-21T10:00:00Z'));
    await expect(useCase.execute(declaration)).rejects.toMatchObject({ reason: 'not-found' });
    expect(objects.sign).toHaveBeenCalledOnce();
  });

  it('withholds a signed capability when the owner abandons during signing', async () => {
    const { work, objects, runtime, store } = fixture();
    objects.sign.mockImplementation(async () => {
      await new AbandonProfileMedia(work).execute(declaration);
      return capability;
    });
    await expect(
      new SignProfileMediaTransfer(work, objects, runtime).execute(declaration),
    ).rejects.toMatchObject({ reason: 'not-found' });
    expect(store.completeSigning).not.toHaveBeenCalled();
    expect(store.releaseSigning).toHaveBeenCalledOnce();
  });

  it('does not elect a candidate after an abandonment during the object write', async () => {
    const { store, work, objects, processor, runtime } = fixture();
    await new SignProfileMediaTransfer(work, objects, runtime).execute(declaration);
    objects.putCandidate.mockImplementation(async () => {
      await new AbandonProfileMedia(work).execute(declaration);
    });
    await expect(
      new PrepareProfileMedia(work, objects, processor, runtime).execute(declaration),
    ).rejects.toMatchObject({ reason: 'upload-superseded' });
    expect(store.electCandidate).not.toHaveBeenCalled();
    expect(store.scheduleCleanup).toHaveBeenCalledOnce();
  });
});
