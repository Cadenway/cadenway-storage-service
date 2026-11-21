import type { ProfileMediaCleanupLease } from '../../../../models/media/profile-media-cleanup-lease.model.js';

/** Erases only a private object named by the durable cleanup ledger. */
export interface ProfileMediaEraser {
  // #region Methods
  /** Makes physical deletion idempotent when the object is already absent. */
  erase(lease: ProfileMediaCleanupLease, signal?: AbortSignal): Promise<void>;
  // #endregion
}
