import { describe, expect, it, vi } from 'vitest';

import type { IntakeAttachmentCleanupUnitOfWork } from '../../../../ports/outbound/transactions/intake-attachment/intake-attachment-cleanup-unit-of-work.port.js';
import { CleanIntakeAttachmentObjects } from './clean-intake-attachment-objects.use-case.js';

describe('CleanIntakeAttachmentObjects', () => {
  it('erases fenced objects outside the tenant transaction and settles successes and failures', async () => {
    const cutoff = new Date('2026-11-20T10:00:00.000Z');
    const objects = [
      { objectKey: 'intake/staging', generation: 1 },
      { objectKey: 'org/tenant/candidate', generation: 2 },
    ];
    const next = { cleanupAfter: cutoff, objectKey: 'org/tenant/candidate' };
    let transactionOpen = false;
    const fenceDueObjects = vi.fn().mockResolvedValue({ objects, next });
    const settleObjectErasures = vi
      .fn()
      .mockImplementation((results: readonly { erased: boolean }[]) => {
        expect(transactionOpen).toBe(true);
        return Promise.resolve(results.filter(({ erased }) => erased).length);
      });
    const work: IntakeAttachmentCleanupUnitOfWork = {
      run: async (organizationId, operation) => {
        expect(organizationId).toBe('tenant');
        transactionOpen = true;
        try {
          return await operation({ fenceDueObjects, settleObjectErasures });
        } finally {
          transactionOpen = false;
        }
      },
    };
    const deleteIntakeObject = vi
      .fn()
      .mockImplementation(
        ({ organizationId, objectKey }: { organizationId: string; objectKey: string }) => {
          expect(transactionOpen).toBe(false);
          expect(organizationId).toBe('tenant');
          return objectKey.startsWith('intake/')
            ? Promise.resolve()
            : Promise.reject(new Error('unavailable'));
        },
      );

    const result = await new CleanIntakeAttachmentObjects(work, { deleteIntakeObject }).execute({
      organizationId: 'tenant',
      cutoff,
      after: null,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ processed: 1, failed: 1, next });
    expect(fenceDueObjects).toHaveBeenCalledWith(cutoff, null, 50);
    expect(settleObjectErasures).toHaveBeenCalledWith([
      { ...objects[0], erased: true },
      { ...objects[1], erased: false },
    ]);
  });

  it('confirms completed erasures before propagating cancellation', async () => {
    const controller = new AbortController();
    const settleObjectErasures = vi.fn().mockResolvedValue(1);
    const work: IntakeAttachmentCleanupUnitOfWork = {
      run: (_organizationId, operation) =>
        operation({
          fenceDueObjects: () =>
            Promise.resolve({
              objects: [
                { objectKey: 'intake/first', generation: 1 },
                { objectKey: 'intake/second', generation: 1 },
              ],
              next: null,
            }),
          settleObjectErasures,
        }),
    };
    const deleteIntakeObject = vi.fn().mockImplementation(() => {
      controller.abort(new Error('cancelled'));
      return Promise.resolve();
    });
    await expect(
      new CleanIntakeAttachmentObjects(work, { deleteIntakeObject }).execute({
        organizationId: 'tenant',
        cutoff: new Date(),
        after: null,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(deleteIntakeObject).toHaveBeenCalledTimes(1);
    expect(settleObjectErasures).toHaveBeenCalledWith([
      { objectKey: 'intake/first', generation: 1, erased: true },
    ]);
  });
});
