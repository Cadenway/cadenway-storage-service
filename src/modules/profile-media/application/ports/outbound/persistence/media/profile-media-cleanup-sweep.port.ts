import type { ProfileMediaCleanupLease } from '../../../../models/media/profile-media-cleanup-lease.model.js';
import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';

/** Persists the global cleanup cursor and executes bounded owner-scoped ledger operations. */
export interface ProfileMediaCleanupSweep {
  // #region Methods
  /** Acquires the exclusive durable cleanup cursor. */
  acquire(): Promise<{ readonly id: string; readonly continuation: string | null } | null>;

  /** Finds at most one owner after the given deterministic cursor. */
  nextOwner(after: ProfileMediaOwnerBinding | null): Promise<ProfileMediaOwnerBinding | null>;

  /** Reclaims expired receipts in one bounded system transaction. */
  purgeExpiredReceipts(limit: number): Promise<number>;

  /** Fences one owner's due objects and returns their deletion leases. */
  claimOwner(
    owner: ProfileMediaOwnerBinding,
    limit: number,
  ): Promise<readonly ProfileMediaCleanupLease[]>;

  /** Removes bounded encrypted receipts belonging to a deleted owner. */
  purgeOwnerReceipts(owner: ProfileMediaOwnerBinding, limit: number): Promise<number>;

  /** Compacts bounded upload data belonging to a deleted owner. */
  compactDeletedOwnerUploads(owner: ProfileMediaOwnerBinding, limit: number): Promise<number>;

  /** Clears a completed owner cleanup marker when no work remains. */
  finishOwner(owner: ProfileMediaOwnerBinding): Promise<boolean>;

  /** Advances the cursor only under its current live lease. */
  advance(id: string, continuation: string | null): Promise<void>;

  /** Releases a failed cursor without advancing it. */
  releaseCursor(id: string): Promise<void>;

  /** Acknowledges an exact object cleanup lease. */
  complete(lease: ProfileMediaCleanupLease): Promise<void>;

  /** Releases an exact failed cleanup lease. */
  release(lease: ProfileMediaCleanupLease): Promise<void>;
  // #endregion
}
