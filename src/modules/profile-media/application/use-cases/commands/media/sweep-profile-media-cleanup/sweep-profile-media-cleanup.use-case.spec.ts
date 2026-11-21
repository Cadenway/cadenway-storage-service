import { describe, expect, it, vi } from 'vitest';

import type { ProfileMediaCleanupLease } from '../../../../models/media/profile-media-cleanup-lease.model.js';
import type { ProfileMediaCleanupSweep } from '../../../../ports/outbound/persistence/media/profile-media-cleanup-sweep.port.js';
import { SweepProfileMediaCleanup } from './sweep-profile-media-cleanup.use-case.js';

const owner = { kind: 'avatar', id: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30' } as const;
const lease: ProfileMediaCleanupLease = {
  owner,
  uploadId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01',
  objectId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01',
  generation: 1,
  leaseId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b02',
};
const secondLease: ProfileMediaCleanupLease = {
  ...lease,
  objectId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b03',
  leaseId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b04',
};

function fixture() {
  const store = {
    acquire: vi.fn().mockResolvedValue({ id: 'lease', continuation: null }),
    nextOwner: vi.fn().mockResolvedValue(owner),
    purgeExpiredReceipts: vi.fn().mockResolvedValue(1),
    claimOwner: vi.fn().mockResolvedValue([lease]),
    purgeOwnerReceipts: vi.fn().mockResolvedValue(1),
    compactDeletedOwnerUploads: vi.fn().mockResolvedValue(1),
    finishOwner: vi.fn().mockResolvedValue(true),
    advance: vi.fn().mockResolvedValue(undefined),
    releaseCursor: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  } satisfies ProfileMediaCleanupSweep;
  return { store, useCase: new SweepProfileMediaCleanup(store) };
}

describe('profile cleanup shares one bounded budget across expired and deleted records', () => {
  it('limits expired receipts and passes the remaining budget through each owner operation', async () => {
    const { store, useCase } = fixture();
    await expect(useCase.execute(8)).resolves.toEqual([lease]);
    expect(store.purgeExpiredReceipts).toHaveBeenCalledWith(2);
    expect(store.nextOwner).toHaveBeenCalledWith(null);
    expect(store.claimOwner).toHaveBeenCalledWith(owner, 7);
    expect(store.purgeOwnerReceipts).toHaveBeenCalledWith(owner, 6);
    expect(store.compactDeletedOwnerUploads).toHaveBeenCalledWith(owner, 5);
    expect(store.finishOwner).toHaveBeenCalledWith(owner);
    expect(store.advance).toHaveBeenCalledWith('lease', JSON.stringify(owner));
    expect(store.releaseCursor).not.toHaveBeenCalled();
  });

  it('retains the owner position when expired receipts exhaust the page', async () => {
    const { store, useCase } = fixture();
    store.acquire.mockResolvedValueOnce({ id: 'lease', continuation: JSON.stringify(owner) });
    await expect(useCase.execute(1)).resolves.toEqual([]);
    expect(store.nextOwner).not.toHaveBeenCalled();
    expect(store.advance).toHaveBeenCalledWith('lease', JSON.stringify(owner));
  });

  it('starts again from the beginning after the last owner', async () => {
    const { store, useCase } = fixture();
    store.acquire.mockResolvedValueOnce({ id: 'lease', continuation: JSON.stringify(owner) });
    store.purgeExpiredReceipts.mockResolvedValueOnce(0);
    store.nextOwner.mockResolvedValueOnce(null);
    await expect(useCase.execute(5)).resolves.toEqual([]);
    expect(store.nextOwner).toHaveBeenCalledWith(owner);
    expect(store.advance).toHaveBeenCalledWith('lease', null);
  });

  it('releases a failed owner scope without advancing so it can be retried', async () => {
    const { store, useCase } = fixture();
    const error = new Error('tenant transaction unavailable');
    store.purgeOwnerReceipts.mockRejectedValueOnce(error);
    await expect(useCase.execute(8)).rejects.toBe(error);
    expect(store.release).toHaveBeenCalledExactlyOnceWith([lease]);
    expect(store.releaseCursor).toHaveBeenCalledWith('lease');
    expect(store.advance).not.toHaveBeenCalled();
    await expect(useCase.execute(8)).resolves.toEqual([lease]);
    expect(store.advance).toHaveBeenCalledOnce();
  });

  it('preserves the failure after trying to release both the objects and the cursor', async () => {
    const { store, useCase } = fixture();
    const error = new Error('cursor update failed');
    store.claimOwner.mockResolvedValueOnce([lease, secondLease]);
    store.advance.mockRejectedValueOnce(error);
    store.release.mockRejectedValueOnce(new Error('object release failed'));
    store.releaseCursor.mockRejectedValueOnce(new Error('cursor release failed'));
    await expect(useCase.execute(8)).rejects.toBe(error);
    expect(store.release).toHaveBeenCalledExactlyOnceWith([lease, secondLease]);
    expect(store.releaseCursor).toHaveBeenCalledExactlyOnceWith('lease');
  });

  it('releases only the cursor when claiming the owner batch fails', async () => {
    const { store, useCase } = fixture();
    const error = new Error('owner claim failed');
    store.claimOwner.mockRejectedValueOnce(error);
    await expect(useCase.execute(8)).rejects.toBe(error);
    expect(store.release).not.toHaveBeenCalled();
    expect(store.releaseCursor).toHaveBeenCalledExactlyOnceWith('lease');
  });

  it.each([0, -1, 501, 1.5])(
    'refuses a cleanup page of %s before acquiring a lease',
    async (limit) => {
      const { store, useCase } = fixture();
      await expect(useCase.execute(limit)).rejects.toBeInstanceOf(RangeError);
      expect(store.acquire).not.toHaveBeenCalled();
    },
  );

  it('acknowledges an exact object lease or releases a batch', async () => {
    const { store, useCase } = fixture();
    await useCase.complete(lease);
    await useCase.release([lease, secondLease]);
    expect(store.complete).toHaveBeenCalledWith(lease);
    expect(store.release).toHaveBeenCalledWith([lease, secondLease]);
  });
});
