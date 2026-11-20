import { describe, expect, it, vi } from 'vitest';

import { Attachment } from '../../../../../domain/aggregates/attachment/attachment.aggregate.js';
import type { AttachmentCleanupTransaction } from '../../../../ports/outbound/persistence/attachment/attachment-cleanup-transaction.port.js';
import type { AttachmentCleanupUnitOfWork } from '../../../../ports/outbound/transactions/attachment/attachment-cleanup-unit-of-work.port.js';
import { CleanPurgedTask } from './clean-purged-task.use-case.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const authorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const attachmentId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
const stagingId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f16';
const now = new Date('2026-11-08T08:01:00.000Z');
const actor = { type: 'system', id: 'task-service' } as const;

function pending(): Attachment {
  return Attachment.reserve({
    id: attachmentId,
    organizationId,
    authorUserId: authorId,
    taskKey: 'CAD-482',
    objectKey: `org/${organizationId}/${attachmentId}`,
    stagingObjectKey: `org/${organizationId}/${stagingId}`,
    fileName: 'example.png',
    contentType: 'image/png',
    sizeBytes: 20,
    reservedAt: new Date('2026-11-08T08:00:00.000Z'),
    expiresAt: new Date('2026-11-08T08:05:00.000Z'),
  });
}

function fixture(attachments: readonly Attachment[], pendingPurge = true) {
  const lockPurgeAttachments = vi.fn().mockResolvedValue(attachments);
  const finishPurge = vi.fn().mockResolvedValue(undefined);
  const deleteAttachment = vi.fn().mockResolvedValue(undefined);
  const appendFact = vi.fn().mockResolvedValue(undefined);
  const store: AttachmentCleanupTransaction = {
    lockPendingPurge: vi.fn().mockResolvedValue(pendingPurge ? actor : null),
    lockPurgeAttachments,
    finishPurge,
    deleteAttachment,
    appendFact,
    fenceDueObjects: vi.fn(),
    settleObjectErasures: vi.fn(),
  };
  const work: AttachmentCleanupUnitOfWork = {
    run: async (scope, operation) => {
      expect(scope).toBe(organizationId);
      return operation(store);
    },
  };
  return {
    lockPurgeAttachments,
    finishPurge,
    deleteAttachment,
    appendFact,
    operation: new CleanPurgedTask(work, { now: () => now, newId: vi.fn() }),
  };
}

describe('CleanPurgedTask', () => {
  const input = { organizationId, taskKey: 'CAD-482' };

  it('discards pending uploads and records one deletion fact for a ready upload', async () => {
    const ready = pending().finalize(
      { sizeBytes: 20, contentType: 'image/png', verifiedContentType: 'image/png' },
      now,
    ).attachment;
    const { operation, lockPurgeAttachments, deleteAttachment, appendFact, finishPurge } = fixture([
      pending(),
      ready,
    ]);

    await expect(operation.execute(input)).resolves.toEqual({ processed: 2, more: false });
    expect(lockPurgeAttachments).toHaveBeenCalledWith('CAD-482', 500);
    expect(deleteAttachment).toHaveBeenCalledTimes(2);
    expect(appendFact).toHaveBeenCalledTimes(1);
    expect(appendFact).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'file.deleted.v1', organizationId }),
      actor,
    );
    expect(finishPurge).toHaveBeenCalledWith('CAD-482');
  });

  it('keeps a full batch pending for another transaction', async () => {
    const { operation, finishPurge } = fixture(Array.from({ length: 500 }, pending));

    await expect(operation.execute(input)).resolves.toEqual({ processed: 500, more: true });
    expect(finishPurge).not.toHaveBeenCalled();
  });

  it('does nothing for an absent or already completed tombstone', async () => {
    const { operation, lockPurgeAttachments, finishPurge } = fixture([], false);

    await expect(operation.execute(input)).resolves.toEqual({ processed: 0, more: false });
    expect(lockPurgeAttachments).not.toHaveBeenCalled();
    expect(finishPurge).not.toHaveBeenCalled();
  });

  it('does not mark cleanup finished if an outbox write fails', async () => {
    const ready = pending().finalize(
      { sizeBytes: 20, contentType: 'image/png', verifiedContentType: 'image/png' },
      now,
    ).attachment;
    const { operation, appendFact, finishPurge } = fixture([ready]);
    appendFact.mockRejectedValueOnce(new Error('outbox unavailable'));

    await expect(operation.execute(input)).rejects.toThrow('outbox unavailable');
    expect(finishPurge).not.toHaveBeenCalled();
  });
});
