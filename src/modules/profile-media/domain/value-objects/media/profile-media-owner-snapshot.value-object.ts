import type { ProfileMediaOwnerBinding } from './profile-media-owner-binding.value-object.js';

/** Durable watermark and current image reference received from the authoritative owner. */
export interface ProfileMediaOwnerSnapshot {
  // #region Properties
  /** Stable owner identity independent of uploader and media IDs. */
  readonly owner: ProfileMediaOwnerBinding;

  /** Highest observed generation of reference changes, or zero before the first change. */
  readonly generation: number;

  /** Latest active reference and irreversible removal fence. */
  readonly assetId: string | null;
  readonly deleted: boolean;
  // #endregion
}
