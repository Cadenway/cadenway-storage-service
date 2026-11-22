import { describe, expect, it, vi } from 'vitest';

import { Attachment } from '../../../../../domain/aggregates/attachment/attachment.aggregate.js';
import type { AttachmentTransaction } from '../../../../models/attachment/attachment-transaction.model.js';
import type { AttachmentUnitOfWork } from '../../../../ports/outbound/transactions/attachment/attachment-unit-of-work.port.js';
import type { AttachmentObjectStore } from '../../../../ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import { CompleteAttachmentUpload } from './complete-attachment-upload.use-case.js';
import { RecordTaskPurge } from '../record-task-purge/record-task-purge.use-case.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const attachmentId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
const stagingId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f16';
const candidateId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f17';
const now = new Date('2026-11-08T08:01:00.000Z');
const expiresAt = new Date('2026-11-08T08:05:00.000Z');

function reservation(): Attachment {
  return Attachment.reserve({
    id: attachmentId,
    organizationId,
    authorUserId: actorId,
    taskKey: 'CAD-482',
    objectKey: `org/${organizationId}/${attachmentId}`,
    stagingObjectKey: `org/${organizationId}/${stagingId}`,
    fileName: 'example.png',
    contentType: 'image/png',
    sizeBytes: 20,
    reservedAt: new Date('2026-11-08T08:00:00.000Z'),
    expiresAt,
  });
}

function fixture(
  initial = reservation(),
  clock = () => now,
  storageLimit: bigint | null = null,
): {
  readonly useCase: CompleteAttachmentUpload;
  readonly registerCandidate: ReturnType<typeof vi.fn<AttachmentTransaction['registerCandidate']>>;
  readonly scheduleCandidateCleanup: ReturnType<
    typeof vi.fn<AttachmentTransaction['scheduleCandidateCleanup']>
  >;
  readonly lockAndReadVerifiedBytes: ReturnType<
    typeof vi.fn<AttachmentTransaction['lockAndReadVerifiedBytes']>
  >;
  readonly electCandidate: ReturnType<typeof vi.fn<AttachmentTransaction['electCandidate']>>;
  readonly appendFact: ReturnType<typeof vi.fn<AttachmentTransaction['appendFact']>>;
  readonly lockAttachment: ReturnType<typeof vi.fn<AttachmentTransaction['lockAttachment']>>;
  readonly lockTask: ReturnType<typeof vi.fn<AttachmentTransaction['lockTask']>>;
  readonly registerTaskPurge: ReturnType<typeof vi.fn<AttachmentTransaction['registerTaskPurge']>>;
  readonly work: AttachmentUnitOfWork;
  readonly committed: ReturnType<typeof vi.fn>;
  readonly copy: ReturnType<typeof vi.fn<AttachmentObjectStore['copyAndVerify']>>;
} {
  let attachment = initial;
  const registerCandidate = vi.fn<AttachmentTransaction['registerCandidate']>();
  const scheduleCandidateCleanup = vi.fn<AttachmentTransaction['scheduleCandidateCleanup']>();
  const electCandidate = vi.fn<AttachmentTransaction['electCandidate']>((ready) => {
    attachment = ready;
    return Promise.resolve(true);
  });
  const appendFact = vi.fn<AttachmentTransaction['appendFact']>();
  const lockAndReadVerifiedBytes = vi
    .fn<AttachmentTransaction['lockAndReadVerifiedBytes']>()
    .mockResolvedValue(0n);
  const registerTaskPurge = vi.fn<AttachmentTransaction['registerTaskPurge']>();
  const lockAttachment = vi.fn<AttachmentTransaction['lockAttachment']>(() =>
    Promise.resolve(attachment),
  );
  const lockTask = vi.fn<AttachmentTransaction['lockTask']>(() => Promise.resolve(false));
  const store: AttachmentTransaction = {
    lockTask,
    registerTaskPurge,
    lockAttachment,
    insertReservation: vi.fn(),
    claimUpload: vi.fn(),
    completeUploadClaim: vi.fn(),
    releaseUploadClaim: vi.fn(),
    registerCandidate,
    scheduleCandidateCleanup,
    lockAndReadVerifiedBytes,
    electCandidate,
    deleteAttachment: vi.fn(),
    appendFact,
  };
  const committed = vi.fn();
  const work: AttachmentUnitOfWork = {
    run: async (_organizationId, operation) => {
      const result = await operation(store);
      committed();
      return result;
    },
  };
  const copy = vi.fn<AttachmentObjectStore['copyAndVerify']>(() =>
    Promise.resolve({
      sizeBytes: 20,
      contentType: 'image/png',
      verifiedContentType: 'image/png',
    }),
  );
  const objects: AttachmentObjectStore = {
    copyAndVerify: copy,
    signUpload: vi.fn(),
    signDownload: vi.fn(),
  };
  return {
    registerCandidate,
    scheduleCandidateCleanup,
    lockAndReadVerifiedBytes,
    electCandidate,
    appendFact,
    lockAttachment,
    lockTask,
    registerTaskPurge,
    work,
    committed,
    copy,
    useCase: new CompleteAttachmentUpload(
      work,
      objects,
      { now: clock, newId: () => Promise.resolve(candidateId) },
      storageLimit,
    ),
  };
}

describe('CompleteAttachmentUpload', () => {
  const input = { organizationId, actorId, taskKey: 'CAD-482', attachmentId };

  it('registers a candidate before copying and emits one fact across a successful replay', async () => {
    const {
      useCase,
      registerCandidate,
      lockAndReadVerifiedBytes,
      electCandidate,
      appendFact,
      copy,
    } = fixture(reservation(), () => now, 20n);
    const first = await useCase.execute(input);
    const second = await useCase.execute(input);
    expect(second).toEqual(first);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(registerCandidate).toHaveBeenCalledTimes(1);
    expect(registerCandidate.mock.invocationCallOrder[0]).toBeLessThan(
      copy.mock.invocationCallOrder[0] ?? 0,
    );
    expect(electCandidate).toHaveBeenCalledTimes(1);
    expect(lockAndReadVerifiedBytes).toHaveBeenCalledOnce();
    expect(appendFact).toHaveBeenCalledTimes(1);
  });

  it('refuses verified bytes over quota before election and leaves the upload retryable', async () => {
    const {
      useCase,
      lockAndReadVerifiedBytes,
      scheduleCandidateCleanup,
      electCandidate,
      appendFact,
      committed,
    } = fixture(reservation(), () => now, 20n);
    lockAndReadVerifiedBytes.mockResolvedValueOnce(1n).mockResolvedValueOnce(0n);
    await expect(useCase.execute(input)).rejects.toMatchObject({
      reason: 'storage-quota-exceeded',
    });
    expect(electCandidate).not.toHaveBeenCalled();
    expect(appendFact).not.toHaveBeenCalled();
    expect(scheduleCandidateCleanup).toHaveBeenCalledExactlyOnceWith(
      attachmentId,
      `org/${organizationId}/${candidateId}`,
    );
    expect(committed).toHaveBeenCalledTimes(2);
    await expect(useCase.execute(input)).resolves.toMatchObject({
      attachment: { id: attachmentId },
    });
    expect(electCandidate).toHaveBeenCalledOnce();
    expect(appendFact).toHaveBeenCalledOnce();
  });

  it('does not acquire the quota lock when enforcement is disabled', async () => {
    const { useCase, lockAndReadVerifiedBytes } = fixture();
    await expect(useCase.execute(input)).resolves.toMatchObject({
      attachment: { id: attachmentId },
    });
    expect(lockAndReadVerifiedBytes).not.toHaveBeenCalled();
  });

  it('rejects metadata that does not describe the copied candidate without electing or publishing', async () => {
    const { useCase, registerCandidate, electCandidate, appendFact, copy } = fixture();
    copy.mockResolvedValueOnce({
      sizeBytes: 21,
      contentType: 'image/png',
      verifiedContentType: 'image/png',
    });
    await expect(useCase.execute(input)).rejects.toMatchObject({
      reason: 'upload-metadata-mismatch',
    });
    expect(registerCandidate).toHaveBeenCalledTimes(1);
    expect(electCandidate).not.toHaveBeenCalled();
    expect(appendFact).not.toHaveBeenCalled();
  });

  it('passes the original purge actor to durable task cleanup', async () => {
    const { work, registerTaskPurge } = fixture();
    const actor = { type: 'automation' as const, id: 'rule-42' };
    await new RecordTaskPurge(work).execute({ organizationId, taskKey: 'CAD-482', actor });
    expect(registerTaskPurge).toHaveBeenCalledWith('CAD-482', actor);
  });

  it('reports the swept reservation expiry only to its uploader on an active task', async () => {
    const { useCase, copy, registerCandidate, lockTask } = fixture(
      reservation().expire(expiresAt),
      () => expiresAt,
    );

    await expect(useCase.execute(input)).rejects.toMatchObject({ reason: 'upload-expired' });
    await expect(
      useCase.execute({ ...input, actorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    ).rejects.toMatchObject({ reason: 'not-found' });
    lockTask.mockResolvedValueOnce(true);
    await expect(useCase.execute(input)).rejects.toMatchObject({ reason: 'not-found' });
    expect(registerCandidate).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it('reports expiry when cleanup discards the reservation while storage is responding', async () => {
    let currentTime = now;
    const pending = reservation();
    const { useCase, copy, lockAttachment, appendFact } = fixture(pending, () => currentTime);
    copy.mockImplementationOnce(() => {
      currentTime = expiresAt;
      lockAttachment.mockResolvedValueOnce(pending.expire(expiresAt));
      return Promise.resolve(null);
    });

    await expect(useCase.execute(input)).rejects.toMatchObject({ reason: 'upload-expired' });
    expect(appendFact).not.toHaveBeenCalled();
  });
});
