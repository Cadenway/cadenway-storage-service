import { describe, expect, it, vi } from 'vitest';

import { IntakeAttachment } from '../../../../../domain/aggregates/intake-attachment/intake-attachment.aggregate.js';
import type { IntakeAttachmentObjectStore } from '../../../../ports/outbound/object-storage/intake-attachment/intake-attachment-object-store.port.js';
import type { AttachmentRuntime } from '../../../../ports/outbound/runtime/attachment/attachment-runtime.port.js';
import type { IntakeAttachmentTransaction } from '../../../../models/intake-attachment/intake-attachment-transaction.model.js';
import type { IntakeAttachmentUnitOfWork } from '../../../../ports/outbound/transactions/intake-attachment/intake-attachment-unit-of-work.port.js';
import { CompleteIntakeAttachmentUpload } from '../complete-intake-attachment-upload/complete-intake-attachment-upload.use-case.js';
import { ClaimIntakeAttachment } from '../claim-intake-attachment/claim-intake-attachment.use-case.js';
import { ReleaseIntakeAttachment } from '../release-intake-attachment/release-intake-attachment.use-case.js';
import { StartIntakeAttachmentUpload } from './start-intake-attachment-upload.use-case.js';

const scope = {
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  publicationId: '019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e01',
  attachmentId: '019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e04',
};
const start = {
  ...scope,
  expiresAt: new Date('2026-11-20T14:30:00Z'),
  fileName: 'capture.png',
  contentType: 'image/png',
  sizeBytes: 20,
};
const candidateId = '019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e05';
const stagingId = '019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e03';
const now = new Date('2026-11-20T14:00:00Z');
const reservation = IntakeAttachment.reserve({
  organizationId: scope.organizationId,
  publicationId: scope.publicationId,
  id: scope.attachmentId,
  stagingObjectKey: `intake/${stagingId}`,
  fileName: start.fileName,
  contentType: start.contentType,
  sizeBytes: start.sizeBytes,
  reservedAt: now,
  expiresAt: start.expiresAt,
});
const verification = { sizeBytes: 20, contentType: 'image/png', verifiedContentType: 'image/png' };

function fixture() {
  let transaction = false;
  const committed = vi.fn();
  const store = {
    lock: vi.fn<IntakeAttachmentTransaction['lock']>().mockResolvedValue(reservation),
    beginSigning: vi.fn<IntakeAttachmentTransaction['beginSigning']>().mockResolvedValue({
      kind: 'acquired',
      claimId: 'lease',
      attachment: reservation,
    }),
    completeSigning: vi
      .fn<IntakeAttachmentTransaction['completeSigning']>()
      .mockResolvedValue({ kind: 'completed' }),
    releaseSigning: vi
      .fn<IntakeAttachmentTransaction['releaseSigning']>()
      .mockResolvedValue(undefined),
    registerCandidate: vi
      .fn<IntakeAttachmentTransaction['registerCandidate']>()
      .mockResolvedValue(undefined),
    scheduleCandidateCleanup: vi
      .fn<IntakeAttachmentTransaction['scheduleCandidateCleanup']>()
      .mockImplementation(() => {
        expect(transaction).toBe(true);
        return Promise.resolve();
      }),
    lockAndReadStorageAdmission: vi
      .fn<IntakeAttachmentTransaction['lockAndReadStorageAdmission']>()
      .mockResolvedValue({ usedBytes: 0n, limitBytes: 20n }),
    electVerified: vi.fn<IntakeAttachmentTransaction['electVerified']>().mockResolvedValue(true),
    lockTask: vi.fn<IntakeAttachmentTransaction['lockTask']>().mockResolvedValue(false),
    saveDecision: vi.fn<IntakeAttachmentTransaction['saveDecision']>().mockResolvedValue(undefined),
  } satisfies IntakeAttachmentTransaction;
  const work: IntakeAttachmentUnitOfWork = {
    run: async (organizationId, callback) => {
      expect(organizationId).toBe(scope.organizationId);
      transaction = true;
      try {
        const result = await callback(store);
        committed();
        return result;
      } finally {
        transaction = false;
      }
    },
  };
  const objects = {
    signIntakeUpload: vi.fn<IntakeAttachmentObjectStore['signIntakeUpload']>(
      ({ attachmentId, stagingKey }) => {
        expect(transaction).toBe(false);
        expect(stagingKey).toBe(`intake/${stagingId}`);
        return Promise.resolve({
          id: attachmentId,
          method: 'POST',
          url: 'https://example.test',
          fields: { key: stagingKey },
          expiresAt: '2026-11-20T14:05:00.000Z',
        });
      },
    ),
    copyAndVerifyIntake: vi.fn<IntakeAttachmentObjectStore['copyAndVerifyIntake']>(() => {
      expect(transaction).toBe(false);
      return Promise.resolve(verification);
    }),
  } satisfies IntakeAttachmentObjectStore;
  const runtime = {
    now: vi.fn(() => now),
    newId: vi.fn().mockResolvedValue(stagingId),
  } satisfies AttachmentRuntime;
  return { store, work, objects, runtime, committed };
}

describe('Anonymous intake attachment transactions', () => {
  it('signs the opaque persisted staging key and saves the precise capability under the lease', async () => {
    const f = fixture();
    const operation = new StartIntakeAttachmentUpload(f.work, f.objects, f.runtime, {
      lookup: () => 'image/png',
    });
    const result = await operation.execute(start);

    expect(result.replayed).toBe(false);
    expect(f.store.completeSigning).toHaveBeenCalledExactlyOnceWith(
      scope,
      'lease',
      result.capability,
    );
    expect(f.store.releaseSigning).not.toHaveBeenCalled();
  });

  it('rejects a release racing with signing and never returns the signed capability', async () => {
    const f = fixture();
    f.store.completeSigning.mockResolvedValue({ kind: 'released' });
    const operation = new StartIntakeAttachmentUpload(f.work, f.objects, f.runtime, {
      lookup: () => 'image/png',
    });

    await expect(operation.execute(start)).rejects.toMatchObject({ reason: 'not-found' });
    expect(f.store.releaseSigning).toHaveBeenCalledExactlyOnceWith(scope, 'lease');
  });

  it('copies outside transactions, then elects the candidate and its verification fact together', async () => {
    const f = fixture();
    f.runtime.newId.mockResolvedValue(candidateId);
    const operation = new CompleteIntakeAttachmentUpload(f.work, f.objects, f.runtime, true);

    await expect(operation.execute(scope)).resolves.toEqual({ id: scope.attachmentId });
    expect(f.store.registerCandidate).toHaveBeenCalledBefore(f.objects.copyAndVerifyIntake);
    expect(f.store.lockAndReadStorageAdmission).toHaveBeenCalledOnce();
    expect(f.store.electVerified).toHaveBeenCalledExactlyOnceWith(
      scope,
      expect.objectContaining({
        snapshot: expect.objectContaining({ status: 'verified' }) as unknown,
      }) as unknown,
      `org/${scope.organizationId}/${candidateId}`,
      expect.objectContaining({
        type: 'intake.attachment-verified.v1',
        attachmentId: scope.attachmentId,
      }) as unknown,
    );
  });

  it('schedules cleanup for a copy refused by quota and accepts a retry after the ceiling increases', async () => {
    const f = fixture();
    const retryCandidateId = '019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e06';
    f.runtime.newId.mockResolvedValueOnce(candidateId).mockResolvedValueOnce(retryCandidateId);
    f.store.lockAndReadStorageAdmission
      .mockResolvedValueOnce({ usedBytes: 1n, limitBytes: 20n })
      .mockResolvedValueOnce({ usedBytes: 1n, limitBytes: 21n });
    const operation = new CompleteIntakeAttachmentUpload(f.work, f.objects, f.runtime, true);

    await expect(operation.execute(scope)).rejects.toMatchObject({
      reason: 'storage-quota-exceeded',
    });
    expect(f.store.electVerified).not.toHaveBeenCalled();
    expect(f.store.scheduleCandidateCleanup).toHaveBeenCalledExactlyOnceWith(
      scope,
      `org/${scope.organizationId}/${candidateId}`,
    );
    expect(f.committed).toHaveBeenCalledTimes(2);
    await expect(operation.execute(scope)).resolves.toEqual({ id: scope.attachmentId });
    expect(f.store.electVerified).toHaveBeenCalledOnce();
    expect(f.store.electVerified.mock.calls[0]?.[2]).toBe(
      `org/${scope.organizationId}/${retryCandidateId}`,
    );
    expect(f.store.scheduleCandidateCleanup).toHaveBeenCalledOnce();
  });

  it('does not acquire the quota lock when enforcement is disabled', async () => {
    const f = fixture();
    const operation = new CompleteIntakeAttachmentUpload(f.work, f.objects, f.runtime);
    await expect(operation.execute(scope)).resolves.toEqual({ id: scope.attachmentId });
    expect(f.store.lockAndReadStorageAdmission).not.toHaveBeenCalled();
  });

  it('refuses a pending upload at the exact signed expiry while its draft remains open', async () => {
    const f = fixture();
    const signedExpiry = new Date('2026-11-20T14:03:00Z');
    const state = reservation.snapshot;
    if (state.reservation === null) throw new Error('Expected an allocated test reservation.');
    f.store.lock.mockResolvedValue(
      IntakeAttachment.rehydrate({
        ...state,
        reservation: { ...state.reservation, uploadExpiresAt: signedExpiry },
      }),
    );
    f.runtime.now.mockReturnValue(signedExpiry);
    const operation = new CompleteIntakeAttachmentUpload(f.work, f.objects, f.runtime);

    await expect(operation.execute(scope)).rejects.toMatchObject({ reason: 'upload-expired' });
    expect(f.store.registerCandidate).not.toHaveBeenCalled();
    expect(f.objects.copyAndVerifyIntake).not.toHaveBeenCalled();
  });

  it('discards a completed copy if the signed window expires before election', async () => {
    const f = fixture();
    f.runtime.newId.mockResolvedValue(candidateId);
    f.runtime.now.mockReturnValueOnce(now).mockReturnValue(new Date('2026-11-20T14:05:00Z'));
    const operation = new CompleteIntakeAttachmentUpload(f.work, f.objects, f.runtime);

    await expect(operation.execute(scope)).rejects.toMatchObject({ reason: 'upload-expired' });
    expect(f.objects.copyAndVerifyIntake).toHaveBeenCalledOnce();
    expect(f.store.electVerified).not.toHaveBeenCalled();
  });

  it('replays an already verified upload after its signed window without another copy or fact', async () => {
    const f = fixture();
    const { intakeAttachment } = reservation.verify(
      `org/${scope.organizationId}/${candidateId}`,
      verification,
      now,
    );
    f.store.lock.mockResolvedValue(intakeAttachment);
    f.runtime.now.mockReturnValue(new Date('2026-11-20T14:06:00Z'));
    const operation = new CompleteIntakeAttachmentUpload(f.work, f.objects, f.runtime);

    await expect(operation.execute(scope)).resolves.toEqual({ id: scope.attachmentId });
    expect(f.objects.copyAndVerifyIntake).not.toHaveBeenCalled();
    expect(f.store.electVerified).not.toHaveBeenCalled();
    expect(f.store.lockAndReadStorageAdmission).not.toHaveBeenCalled();
  });

  it('leaves a release tombstone for a reservation that has not arrived and never attaches a purged task', async () => {
    const f = fixture();
    f.store.lock.mockResolvedValueOnce(null);
    const release = new ReleaseIntakeAttachment(f.work, f.runtime);
    await release.execute(scope);
    expect(f.store.saveDecision).toHaveBeenCalledExactlyOnceWith(
      scope,
      expect.objectContaining({
        snapshot: expect.objectContaining({ status: 'released', reservation: null }) as unknown,
      }) as unknown,
      null,
      null,
    );
    const verified = reservation.verify(
      `org/${scope.organizationId}/${candidateId}`,
      verification,
      now,
    ).intakeAttachment;
    f.store.lock.mockClear();
    f.store.lock.mockResolvedValueOnce(verified);
    f.store.lockTask.mockResolvedValueOnce(true);
    const claim = new ClaimIntakeAttachment(f.work, f.runtime);
    await claim.execute({ ...scope, taskKey: 'CAD-482' });
    expect(f.store.lockTask).toHaveBeenCalledBefore(f.store.lock);
    expect(f.store.saveDecision).toHaveBeenLastCalledWith(
      { ...scope, taskKey: 'CAD-482' },
      expect.objectContaining({
        snapshot: expect.objectContaining({ status: 'claimed' }) as unknown,
      }) as unknown,
      null,
      null,
    );
  });

  it('preserves a claim arriving before its reservation without publishing a file fact', async () => {
    const f = fixture();
    f.store.lock.mockResolvedValueOnce(null);
    const claim = new ClaimIntakeAttachment(f.work, f.runtime);
    const input = { ...scope, taskKey: 'CAD-482' };

    await claim.execute(input);

    const saved = f.store.saveDecision.mock.calls[0];
    expect(saved?.[0]).toEqual(input);
    expect(saved?.[1].snapshot).toMatchObject({
      status: 'claimed',
      taskKey: input.taskKey,
      reservation: null,
    });
    expect(saved?.[2]).toBeNull();
    expect(saved?.[3]).toBeNull();
  });
});
