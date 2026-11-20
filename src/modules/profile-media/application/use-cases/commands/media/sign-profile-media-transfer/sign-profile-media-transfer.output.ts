import type { ProfileMediaCapability } from '../../../../models/media/profile-media-capability.model.js';

/** A signed response preserved byte-for-byte for an authorized replay. */
export interface SignProfileMediaTransferOutput {
  // #region Properties
  /** Scoped operation or value. */
  readonly capability: ProfileMediaCapability;
  // #endregion
}
