import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';

/** Exact reference already authorized by the Gateway. */
export interface ReadProfileMediaInput {
  // #region Properties
  /** Scoped operation or value. */
  readonly owner: ProfileMediaOwnerBinding;
  readonly assetId: string;
  readonly signal?: AbortSignal;
  // #endregion
}
