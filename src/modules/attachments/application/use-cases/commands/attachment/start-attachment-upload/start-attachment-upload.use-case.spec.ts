import { describe, expect, it, vi } from 'vitest';

import type { AttachmentTransaction } from '../../../../models/attachment/attachment-transaction.model.js';
import type { UploadCapability } from '../../../../models/attachment/upload-capability.model.js';
import type { AttachmentMediaTypeLookup } from '../../../../ports/outbound/media-types/attachment/attachment-media-type-lookup.port.js';
import type { AttachmentObjectStore } from '../../../../ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import type { AttachmentRuntime } from '../../../../ports/outbound/runtime/attachment/attachment-runtime.port.js';
import type { StartAttachmentUploadInput } from './start-attachment-upload.input.js';
import { StartAttachmentUpload } from './start-attachment-upload.use-case.js';

const input: StartAttachmentUploadInput = {
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  taskKey: 'CAD-482',
  fileName: 'example.png',
  contentType: 'image/png',
  sizeBytes: 20,
  idempotencyKey: 'synthetic-repeat-key',
  fingerprint: 'a'.repeat(64),
};
const original: UploadCapability = {
  id: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15',
  method: 'POST',
  url: 'https://files.example.test/atelier-nord',
  fields: { policy: 'original-fixture-policy' },
  expiresAt: '2026-11-08T07:05:00.000Z',
};
const lease = { kind: 'acquired', claimId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f18' } as const;
const signed = {
  ...original,
  id: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f16',
  expiresAt: '2026-11-08T08:04:59.000Z',
};

function deferred<Value>() {
  let finish: (value: Value) => void = () => {
    throw new Error('Deferred promise has no resolver.');
  };
  const promise = new Promise<Value>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

function fixture() {
  let activeTransactions = 0;
  const store = {
    lockTask: vi.fn<AttachmentTransaction['lockTask']>().mockResolvedValue(false),
    registerTaskPurge: vi.fn<AttachmentTransaction['registerTaskPurge']>(),
    lockAttachment: vi.fn<AttachmentTransaction['lockAttachment']>(),
    insertReservation: vi.fn<AttachmentTransaction['insertReservation']>(),
    claimUpload: vi.fn<AttachmentTransaction['claimUpload']>().mockResolvedValue(lease),
    completeUploadClaim: vi
      .fn<AttachmentTransaction['completeUploadClaim']>()
      .mockResolvedValue({ kind: 'completed' }),
    releaseUploadClaim: vi.fn<AttachmentTransaction['releaseUploadClaim']>(),
    registerCandidate: vi.fn<AttachmentTransaction['registerCandidate']>(),
    scheduleCandidateCleanup: vi.fn<AttachmentTransaction['scheduleCandidateCleanup']>(),
    lockAndReadStorageAdmission: vi
      .fn<AttachmentTransaction['lockAndReadStorageAdmission']>()
      .mockResolvedValue({ usedBytes: 80n, limitBytes: 100n }),
    lockAndReadStorageEntitlement: vi.fn(),
    saveStorageEntitlement: vi.fn(),
    electCandidate: vi.fn<AttachmentTransaction['electCandidate']>(),
    deleteAttachment: vi.fn<AttachmentTransaction['deleteAttachment']>(),
    appendFact: vi.fn<AttachmentTransaction['appendFact']>(),
  } satisfies AttachmentTransaction;
  const objects = {
    signUpload: vi.fn<AttachmentObjectStore['signUpload']>().mockResolvedValue(signed),
    copyAndVerify: vi.fn<AttachmentObjectStore['copyAndVerify']>(),
    retainCandidate: vi.fn<AttachmentObjectStore['retainCandidate']>(),
    signDownload: vi.fn<AttachmentObjectStore['signDownload']>(),
  } satisfies AttachmentObjectStore;
  const runtime = {
    now: vi.fn(() => new Date('2026-11-08T08:00:00.000Z')),
    newId: vi
      .fn<AttachmentRuntime['newId']>()
      .mockResolvedValueOnce('019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f16')
      .mockResolvedValueOnce('019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f17'),
  } satisfies AttachmentRuntime;
  const mediaTypeForFile = vi
    .fn<AttachmentMediaTypeLookup['lookup']>()
    .mockReturnValue('image/png');
  return {
    store,
    objects,
    runtime,
    mediaTypeForFile,
    activeTransactions: () => activeTransactions,
    useCase: new StartAttachmentUpload(
      {
        run: async (_tenant, work) => {
          ++activeTransactions;
          try {
            return await work(store);
          } finally {
            --activeTransactions;
          }
        },
      },
      objects,
      runtime,
      { lookup: mediaTypeForFile },
    ),
  };
}

describe('StartAttachmentUpload', () => {
  it('replays the original expiry and fields without signing or allocating a new attachment', async () => {
    const { useCase, store, objects, runtime, mediaTypeForFile } = fixture();
    store.claimUpload.mockResolvedValue({ kind: 'replay', response: original });

    await expect(useCase.execute(input)).resolves.toEqual({ capability: original, replayed: true });
    expect(store.lockTask).toHaveBeenCalledWith(input.taskKey);
    expect(store.claimUpload).toHaveBeenCalledWith(
      input.actorId,
      input.taskKey,
      input.idempotencyKey,
      input.fingerprint,
    );
    expect(objects.signUpload).not.toHaveBeenCalled();
    expect(runtime.newId).not.toHaveBeenCalled();
    expect(mediaTypeForFile).not.toHaveBeenCalled();
    expect(store.insertReservation).not.toHaveBeenCalled();
    expect(store.lockAndReadStorageAdmission).not.toHaveBeenCalled();
  });

  it('checks task revocation before reading a stored response', async () => {
    const { useCase, store, objects } = fixture();
    store.lockTask.mockResolvedValue(true);

    await expect(useCase.execute(input)).rejects.toMatchObject({ reason: 'not-found' });
    expect(store.claimUpload).not.toHaveBeenCalled();
    expect(objects.signUpload).not.toHaveBeenCalled();
  });

  it('returns the concurrent winner and leaves its receipt untouched after signing', async () => {
    const { useCase, store, objects } = fixture();
    store.completeUploadClaim.mockResolvedValueOnce({ kind: 'replay', response: original });

    await expect(useCase.execute(input)).resolves.toEqual({ capability: original, replayed: true });
    expect(objects.signUpload).toHaveBeenCalledTimes(1);
    expect(store.lockTask).toHaveBeenCalledTimes(2);
    expect(store.insertReservation).not.toHaveBeenCalled();
    expect(store.releaseUploadClaim).not.toHaveBeenCalled();
  });

  it('persists the original response and exact signed expiration under the owned lease', async () => {
    const { useCase, store, objects } = fixture();

    const result = await useCase.execute(input);

    expect(result.replayed).toBe(false);
    expect(objects.signUpload).toHaveBeenCalledTimes(1);
    expect(store.lockTask).toHaveBeenCalledTimes(2);
    expect(store.claimUpload).toHaveBeenCalledTimes(1);
    expect(store.insertReservation).toHaveBeenCalledTimes(1);
    expect(store.lockAndReadStorageAdmission).toHaveBeenCalledExactlyOnceWith(true);
    expect(store.lockAndReadStorageAdmission).toHaveBeenCalledBefore(store.insertReservation);
    expect(store.insertReservation.mock.calls[0]?.[0].snapshot.expiresAt).toEqual(
      new Date(signed.expiresAt),
    );
    expect(store.completeUploadClaim).toHaveBeenCalledExactlyOnceWith(
      input.actorId,
      input.taskKey,
      input.idempotencyKey,
      input.fingerprint,
      lease.claimId,
      result.capability,
    );
  });

  it('does not persist or return a capability over the available quota', async () => {
    const { useCase, store } = fixture();
    store.lockAndReadStorageAdmission.mockResolvedValueOnce({ usedBytes: 81n, limitBytes: 100n });

    await expect(useCase.execute(input)).rejects.toMatchObject({
      reason: 'storage-quota-exceeded',
    });
    expect(store.insertReservation).not.toHaveBeenCalled();
    expect(store.releaseUploadClaim).toHaveBeenCalledOnce();
  });

  it('refuses competing requests while the winner signs outside the transaction', async () => {
    const { useCase, store, objects, activeTransactions } = fixture();
    const enteredSigning = deferred<undefined>();
    const finishSigning = deferred<UploadCapability>();
    objects.signUpload.mockImplementationOnce(() => {
      enteredSigning.finish(undefined);
      return finishSigning.promise;
    });
    store.claimUpload
      .mockResolvedValueOnce(lease)
      .mockResolvedValueOnce({ kind: 'in-progress' })
      .mockResolvedValueOnce({ kind: 'key-reused' });

    const winner = useCase.execute(input);
    await enteredSigning.promise;
    expect(activeTransactions()).toBe(0);
    await expect(useCase.execute(input)).rejects.toMatchObject({ reason: 'request-in-progress' });
    await expect(useCase.execute({ ...input, fingerprint: 'b'.repeat(64) })).rejects.toMatchObject({
      reason: 'idempotency-key-reused',
    });
    expect(objects.signUpload).toHaveBeenCalledTimes(1);
    finishSigning.finish(signed);
    await expect(winner).resolves.toEqual({ capability: signed, replayed: false });
  });

  it('releases only the owned lease when the signer fails', async () => {
    const { useCase, store, objects } = fixture();
    const failure = new Error('Signing unavailable');
    objects.signUpload.mockRejectedValueOnce(failure);

    await expect(useCase.execute(input)).rejects.toBe(failure);
    expect(store.releaseUploadClaim).toHaveBeenCalledExactlyOnceWith(
      input.actorId,
      input.taskKey,
      input.idempotencyKey,
      lease.claimId,
    );
    expect(store.insertReservation).not.toHaveBeenCalled();
    expect(store.completeUploadClaim).not.toHaveBeenCalled();
  });

  it('refuses to commit a signed response that expired while signing', async () => {
    const { useCase, store, runtime } = fixture();
    runtime.now.mockReturnValueOnce(new Date('2026-11-08T08:00:00.000Z'));
    runtime.now.mockReturnValueOnce(new Date(signed.expiresAt));

    await expect(useCase.execute(input)).rejects.toThrow('expired before reservation');
    expect(store.releaseUploadClaim).toHaveBeenCalledOnce();
    expect(store.insertReservation).not.toHaveBeenCalled();
    expect(store.completeUploadClaim).not.toHaveBeenCalled();
  });

  it.each(['text/plain', null])(
    'refuses a mismatched or unregistered extension before signing: %s',
    async (mediaType) => {
      const { useCase, store, objects, mediaTypeForFile } = fixture();
      mediaTypeForFile.mockReturnValue(mediaType);

      await expect(useCase.execute(input)).rejects.toMatchObject({
        reason: 'upload-metadata-mismatch',
      });
      expect(mediaTypeForFile).toHaveBeenCalledWith(input.fileName);
      expect(objects.signUpload).not.toHaveBeenCalled();
      expect(store.insertReservation).not.toHaveBeenCalled();
      expect(store.completeUploadClaim).not.toHaveBeenCalled();
    },
  );

  it('signs the canonical media type when the declared type uses uppercase letters', async () => {
    const { useCase, objects, mediaTypeForFile } = fixture();
    mediaTypeForFile.mockReturnValue('text/plain');
    await useCase.execute({ ...input, fileName: 'Atelier Nord.LOG', contentType: 'Text/Plain' });

    expect(mediaTypeForFile).toHaveBeenCalledWith('Atelier Nord.LOG');
    expect(objects.signUpload).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'text/plain', sizeBytes: input.sizeBytes }),
    );
  });
});
