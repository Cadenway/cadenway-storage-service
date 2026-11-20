import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';

/** Owner-service reference fact, already authenticated and validated by its handler. */
export interface ApplyProfileMediaChangeInput {
  // #region Properties
  /** Scoped operation or value. */
  readonly owner: ProfileMediaOwnerBinding;
  readonly generation: number;
  readonly assetId: string | null;
  readonly oldAssetId: string | null;
  // #endregion
}
