import { describe, expect, it, vi } from 'vitest';

import type { AttachmentObjectPage } from '../../../../models/attachment/attachment-object-page.model.js';
import type { AttachmentObjectInventory } from '../../../../ports/outbound/object-storage/attachment/attachment-object-inventory.port.js';
import type { AttachmentReconciliation } from '../../../../ports/outbound/persistence/attachment/attachment-reconciliation.port.js';
import { ReconcileAttachmentObjects } from './reconcile-attachment-objects.use-case.js';

const organizationId = '11111111-2222-4333-8444-555555555555';
const lastPage: AttachmentObjectPage = {
  objects: [
    { organizationId, objectKey: `org/${organizationId}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b02` },
  ],
  next: null,
};

function fixture() {
  const reconciliation = {
    acquire: vi.fn<AttachmentReconciliation['acquire']>(),
    complete: vi.fn<AttachmentReconciliation['complete']>(),
    release: vi.fn<AttachmentReconciliation['release']>().mockResolvedValue(undefined),
  };
  const inventory = {
    listAttachmentObjects: vi.fn<AttachmentObjectInventory['listAttachmentObjects']>(),
  };
  return {
    useCase: new ReconcileAttachmentObjects(reconciliation, inventory),
    reconciliation,
    inventory,
  };
}

describe('ReconcileAttachmentObjects', () => {
  it('resumes the same position after a failed list and restarts after the last page', async () => {
    const { useCase, reconciliation, inventory } = fixture();
    const signal = new AbortController().signal;
    const error = new Error('The inventory request failed.');
    reconciliation.acquire
      .mockResolvedValueOnce({ id: 'failed', continuation: 'page-two' })
      .mockResolvedValueOnce({ id: 'retried', continuation: 'page-two' })
      .mockResolvedValueOnce({ id: 'next-pass', continuation: null });
    reconciliation.complete.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    inventory.listAttachmentObjects
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(lastPage)
      .mockResolvedValueOnce({ objects: [], next: 'page-two' });

    await expect(useCase.execute({ signal })).rejects.toBe(error);
    expect(reconciliation.release).toHaveBeenCalledExactlyOnceWith('failed');
    expect(reconciliation.complete).not.toHaveBeenCalled();

    await expect(useCase.execute({ signal })).resolves.toEqual({ requeued: 1 });
    expect(reconciliation.complete).toHaveBeenLastCalledWith('retried', lastPage);
    await expect(useCase.execute({ signal })).resolves.toEqual({ requeued: 0 });
    expect(inventory.listAttachmentObjects.mock.calls).toEqual([
      ['page-two', signal],
      ['page-two', signal],
      [null, signal],
    ]);
  });

  it('leaves the inventory alone while another worker holds the lease', async () => {
    const { useCase, reconciliation, inventory } = fixture();
    reconciliation.acquire.mockResolvedValue(null);

    await expect(useCase.execute({ signal: new AbortController().signal })).resolves.toEqual({
      requeued: 0,
    });
    expect(inventory.listAttachmentObjects).not.toHaveBeenCalled();
    expect(reconciliation.complete).not.toHaveBeenCalled();
  });

  it('reports no requeue when a newer owner has already taken the expired lease', async () => {
    const { useCase, reconciliation, inventory } = fixture();
    reconciliation.acquire.mockResolvedValue({ id: 'expired', continuation: null });
    reconciliation.complete.mockResolvedValue(null);
    inventory.listAttachmentObjects.mockResolvedValue(lastPage);

    await expect(useCase.execute({ signal: new AbortController().signal })).resolves.toEqual({
      requeued: 0,
    });
    expect(reconciliation.complete).toHaveBeenCalledExactlyOnceWith('expired', lastPage);
    expect(reconciliation.release).not.toHaveBeenCalled();
  });

  it('retains the current position when a worker stops during the list', async () => {
    const { useCase, reconciliation, inventory } = fixture();
    const controller = new AbortController();
    reconciliation.acquire.mockResolvedValue({ id: 'stopping', continuation: 'page-two' });
    inventory.listAttachmentObjects.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(lastPage);
    });

    await expect(useCase.execute({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(reconciliation.release).toHaveBeenCalledExactlyOnceWith('stopping');
    expect(reconciliation.complete).not.toHaveBeenCalled();
  });
});
