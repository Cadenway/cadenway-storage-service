import type { ProfileMediaCleanupLease } from '../../../../models/media/profile-media-cleanup-lease.model.js';

/** Provides bounded exclusive leases without deleting selected or still-writable objects. */
export interface ProfileMediaCleanup {
  // #region Methods
  /** Claims at most the requested number of due objects, including expired owner cleanup. */
  claim(limit: number): Promise<readonly ProfileMediaCleanupLease[]>;

  /** Completes only the generation and lease that authorized this deletion. */
  complete(lease: ProfileMediaCleanupLease): Promise<void>;

  /** Releases an unfinished batch of exact cleanup leases for one owner. */
  release(leases: readonly ProfileMediaCleanupLease[]): Promise<void>;
  // #endregion
}
