import { describe, expect, it, vi } from 'vitest';

import type { ProfileMediaObjectInventory } from '../../../../ports/outbound/object-storage/media/profile-media-object-inventory.port.js';
import type { ProfileMediaReconciliation } from '../../../../ports/outbound/persistence/media/profile-media-reconciliation.port.js';
import { ReconcileProfileMedia } from './reconcile-profile-media.use-case.js';

const avatar = { kind: 'avatar', id: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30' } as const;
const logo = { kind: 'organization-logo', id: '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f12' } as const;
const observedAvatar = {
  kind: avatar.kind,
  ownerId: avatar.id,
  role: 'staging',
  uploadId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01',
  objectId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01',
} as const;
const observedLogo = { ...observedAvatar, kind: logo.kind, ownerId: logo.id } as const;

function fixture() {
  const store = {
    acquire: vi.fn().mockResolvedValue({ id: 'lease', continuation: 'first' }),
    resolve: vi.fn().mockResolvedValue([observedAvatar, observedLogo, observedAvatar]),
    requeue: vi.fn().mockResolvedValue(1),
    advance: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  } satisfies ProfileMediaReconciliation;
  const inventory = {
    listProfileMediaObjects: vi.fn().mockResolvedValue({ objects: [], next: 'second' }),
  } satisfies ProfileMediaObjectInventory;
  return { store, inventory, useCase: new ReconcileProfileMedia(store, inventory) };
}

describe('profile inventory advances only after every owner is reconciled', () => {
  it('groups the page by owner and advances after each scoped recheck', async () => {
    const { store, inventory, useCase } = fixture();
    const signal = new AbortController().signal;
    await expect(useCase.execute(signal)).resolves.toBe(2);
    expect(inventory.listProfileMediaObjects).toHaveBeenCalledWith('first', signal);
    expect(store.requeue).toHaveBeenNthCalledWith(1, avatar, [observedAvatar, observedAvatar]);
    expect(store.requeue).toHaveBeenNthCalledWith(2, logo, [observedLogo]);
    expect(store.advance).toHaveBeenCalledWith('lease', 'second');
    expect(store.release).not.toHaveBeenCalled();
  });

  it('releases an incomplete lease when an owner transaction fails so the page can be retried', async () => {
    const { store, useCase } = fixture();
    const error = new Error('owner unavailable');
    store.requeue.mockResolvedValueOnce(1).mockRejectedValueOnce(error);
    await expect(useCase.execute(new AbortController().signal)).rejects.toBe(error);
    expect(store.advance).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledWith('lease');
    await expect(useCase.execute(new AbortController().signal)).resolves.toBe(2);
    expect(store.advance).toHaveBeenCalledOnce();
  });

  it('releases the cursor on a failed inventory call and refuses an oversized page', async () => {
    const { store, inventory, useCase } = fixture();
    const failure = new Error('inventory unavailable');
    inventory.listProfileMediaObjects.mockRejectedValueOnce(failure);
    await expect(useCase.execute(new AbortController().signal)).rejects.toBe(failure);
    expect(store.release).toHaveBeenCalledWith('lease');
    inventory.listProfileMediaObjects.mockResolvedValueOnce({
      objects: Array.from({ length: 501 }, () => ({
        role: 'staging' as const,
        objectId: observedAvatar.objectId,
      })),
      next: null,
    });
    await expect(useCase.execute(new AbortController().signal)).rejects.toBeInstanceOf(RangeError);
    expect(store.resolve).not.toHaveBeenCalled();
    expect(store.advance).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledTimes(2);
  });

  it('does no work when another worker holds the cursor', async () => {
    const { store, inventory, useCase } = fixture();
    store.acquire.mockResolvedValueOnce(null);
    await expect(useCase.execute(new AbortController().signal)).resolves.toBe(0);
    expect(inventory.listProfileMediaObjects).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
  });
});
