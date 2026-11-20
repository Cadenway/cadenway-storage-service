import { describe, expect, it, vi } from 'vitest';

import { Attachment } from '../../../../../domain/aggregates/attachment/attachment.aggregate.js';
import type { AttachmentCleanupTransaction } from '../../../../ports/outbound/persistence/attachment/attachment-cleanup-transaction.port.js';
import type { AttachmentCleanupUnitOfWork } from '../../../../ports/outbound/transactions/attachment/attachment-cleanup-unit-of-work.port.js';
import { CleanAttachmentObjects } from './clean-attachment-objects.use-case.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const cutoff = new Date('2026-11-08T08:05:00.000Z');

function fixture(count: number) {
  const fenced = Array.from({ length: count }, (_, index) => ({
    generation: 1,
    objectKey: `org/${organizationId}/${String(index).padStart(4, '0')}`,
  }));
  const last = fenced.at(-1);
  const next =
    count === 50 && last !== undefined ? { cleanupAfter: cutoff, objectKey: last.objectKey } : null;
  let transactionOpen = false;
  const fenceDueObjects = vi
    .fn<AttachmentCleanupTransaction['fenceDueObjects']>()
    .mockResolvedValue({ objects: fenced, pendingAttachments: [], next });
  const settleObjectErasures = vi
    .fn<AttachmentCleanupTransaction['settleObjectErasures']>()
    .mockImplementation((results) => {
      expect(transactionOpen).toBe(true);
      return Promise.resolve(results.filter(({ erased }) => erased).length);
    });
  const deleteAttachment = vi.fn<AttachmentCleanupTransaction['deleteAttachment']>();
  const store: AttachmentCleanupTransaction = {
    fenceDueObjects,
    settleObjectErasures,
    lockPendingPurge: vi.fn(),
    lockPurgeAttachments: vi.fn(),
    finishPurge: vi.fn(),
    deleteAttachment,
    appendFact: vi.fn(),
  };
  const work: AttachmentCleanupUnitOfWork = {
    run: async (scope, operation) => {
      expect(scope).toBe(organizationId);
      transactionOpen = true;
      try {
        return await operation(store);
      } finally {
        transactionOpen = false;
      }
    },
  };
  const remove = vi.fn((key: string) => {
    expect(transactionOpen).toBe(false);
    expect(key).toMatch(/^org\//u);
    return Promise.resolve();
  });
  return {
    operation: new CleanAttachmentObjects(work, { deleteObject: remove }),
    fenceDueObjects,
    settleObjectErasures,
    deleteAttachment,
    remove,
    fenced,
    next,
  };
}

describe('CleanAttachmentObjects', () => {
  it('removes only fenced objects after their transaction commits', async () => {
    const { operation, fenceDueObjects, settleObjectErasures, remove, fenced } = fixture(2);
    const signal = new AbortController().signal;

    await expect(
      operation.execute({ organizationId, cutoff, after: null, signal }),
    ).resolves.toEqual({
      processed: 2,
      failed: 0,
      next: null,
    });
    expect(fenceDueObjects).toHaveBeenCalledWith(cutoff, null, 50);
    expect(remove.mock.calls.map(([key]) => key)).toEqual(fenced.map(({ objectKey }) => objectKey));
    expect(settleObjectErasures).toHaveBeenCalledWith(
      fenced.map((object) => ({ ...object, erased: true })),
    );
    expect(settleObjectErasures.mock.invocationCallOrder[0]).toBeGreaterThan(
      remove.mock.invocationCallOrder.at(-1) ?? 0,
    );
  });

  it('returns a stable cursor for a full page', async () => {
    const { operation, next } = fixture(50);
    const signal = new AbortController().signal;

    await expect(
      operation.execute({ organizationId, cutoff, after: null, signal }),
    ).resolves.toEqual({
      processed: 50,
      failed: 0,
      next,
    });
  });

  it('advances past a scanned page whose candidates were concurrently elected', async () => {
    const { operation, fenceDueObjects, settleObjectErasures, remove } = fixture(0);
    const cursor = { cleanupAfter: cutoff, objectKey: 'org/example/scanned' };
    fenceDueObjects.mockResolvedValueOnce({ objects: [], pendingAttachments: [], next: cursor });

    await expect(
      operation.execute({
        organizationId,
        cutoff,
        after: null,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ processed: 0, failed: 0, next: cursor });
    expect(remove).not.toHaveBeenCalled();
    expect(settleObjectErasures).not.toHaveBeenCalled();
  });

  it('reports a failed erase and keeps later objects and pages reachable', async () => {
    const { operation, fenceDueObjects, settleObjectErasures, remove, fenced } = fixture(2);
    const signal = new AbortController().signal;
    const next = { cleanupAfter: cutoff, objectKey: 'org/example/scanned' };
    fenceDueObjects.mockResolvedValueOnce({ objects: fenced, pendingAttachments: [], next });
    remove.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(
      operation.execute({ organizationId, cutoff, after: null, signal }),
    ).resolves.toEqual({ processed: 1, failed: 1, next });
    expect(remove.mock.calls.map(([key]) => key)).toEqual(fenced.map(({ objectKey }) => objectKey));
    expect(settleObjectErasures).toHaveBeenCalledWith(
      fenced.map((object, index) => ({ ...object, erased: index !== 0 })),
    );
  });

  it('counts only erasures confirmed for the active generation', async () => {
    const { operation, settleObjectErasures } = fixture(1);
    settleObjectErasures.mockResolvedValueOnce(0);

    await expect(
      operation.execute({
        organizationId,
        cutoff,
        after: null,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ processed: 0, failed: 0, next: null });
  });

  it('discards an expired pending reservation under the object fence before calling storage', async () => {
    const { operation, fenceDueObjects, deleteAttachment, remove, fenced } = fixture(1);
    const attachmentId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
    const pending = Attachment.reserve({
      id: attachmentId,
      organizationId,
      authorUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      taskKey: 'CAD-482',
      objectKey: `org/${organizationId}/${attachmentId}`,
      stagingObjectKey: `org/${organizationId}/019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f16`,
      fileName: 'example.png',
      contentType: 'image/png',
      sizeBytes: 20,
      reservedAt: new Date('2026-11-08T08:00:00.000Z'),
      expiresAt: cutoff,
    });
    fenceDueObjects.mockResolvedValueOnce({
      objects: fenced,
      pendingAttachments: [pending],
      next: null,
    });

    await operation.execute({
      organizationId,
      cutoff,
      after: null,
      signal: new AbortController().signal,
    });

    expect(deleteAttachment.mock.calls[0]?.[0]?.snapshot).toMatchObject({
      status: 'deleted',
      uploadedAt: null,
      deletedAt: cutoff,
    });
    expect(deleteAttachment.mock.invocationCallOrder[0]).toBeLessThan(
      remove.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('stops after cancellation during an erase even when the object provider fails', async () => {
    const { operation, remove } = fixture(2);
    const controller = new AbortController();
    remove.mockImplementationOnce(() => {
      controller.abort(new Error('job cancelled'));
      return Promise.reject(new Error('storage unavailable'));
    });

    await expect(
      operation.execute({ organizationId, cutoff, after: null, signal: controller.signal }),
    ).rejects.toThrow('job cancelled');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('stops before starting a page when the job has been cancelled', async () => {
    const { operation, fenceDueObjects, remove } = fixture(1);
    const controller = new AbortController();
    controller.abort();

    await expect(
      operation.execute({ organizationId, cutoff, after: null, signal: controller.signal }),
    ).rejects.toThrow();
    expect(fenceDueObjects).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
