import type { ProfileMediaCleanupLease } from '../../../../models/media/profile-media-cleanup-lease.model.js';
import type { ProfileMediaCleanupSweep } from '../../../../ports/outbound/persistence/media/profile-media-cleanup-sweep.port.js';
import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';

/** Applies a shared bounded budget while advancing the durable owner cleanup scan. */
export class SweepProfileMediaCleanup {
  // #region Constructor
  /** Binds cursor and exact-owner operations. */
  public constructor(private readonly store: ProfileMediaCleanupSweep) {}
  // #endregion

  // #region Methods
  /** Fences due objects and processes bounded expired and deleted-owner records. */
  public async execute(limit: number): Promise<readonly ProfileMediaCleanupLease[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new RangeError('Invalid profile cleanup page.');
    const cursor = await this.store.acquire();
    if (cursor === null) return [];
    try {
      const expired = await this.store.purgeExpiredReceipts(Math.max(1, Math.floor(limit / 4)));
      const remaining = limit - expired;
      if (remaining === 0) {
        await this.store.advance(cursor.id, cursor.continuation);
        return [];
      }
      const after = cursor.continuation === null ? null : this.decodeOwner(cursor.continuation);
      const owner = await this.store.nextOwner(after);
      if (owner === null) {
        await this.store.advance(cursor.id, null);
        return [];
      }
      const leases = await this.store.claimOwner(owner, remaining);
      let budget = remaining - leases.length;
      if (budget > 0) budget -= await this.store.purgeOwnerReceipts(owner, budget);
      if (budget > 0) await this.store.compactDeletedOwnerUploads(owner, budget);
      await this.store.finishOwner(owner);
      await this.store.advance(cursor.id, JSON.stringify(owner));
      return leases;
    } catch (error) {
      await this.store.releaseCursor(cursor.id);
      throw error;
    }
  }

  /** Acknowledges a completed physical erasure. */
  public complete(lease: ProfileMediaCleanupLease): Promise<void> {
    return this.store.complete(lease);
  }

  /** Reschedules a failed physical erasure. */
  public release(lease: ProfileMediaCleanupLease): Promise<void> {
    return this.store.release(lease);
  }

  private decodeOwner(value: string): ProfileMediaOwnerBinding {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('kind' in parsed) ||
      !('id' in parsed) ||
      (parsed.kind !== 'avatar' && parsed.kind !== 'organization-logo') ||
      typeof parsed.id !== 'string' ||
      !/^[0-9a-f-]{36}$/u.test(parsed.id)
    )
      throw new Error('Invalid profile cleanup cursor.');
    return { kind: parsed.kind, id: parsed.id };
  }
  // #endregion
}
