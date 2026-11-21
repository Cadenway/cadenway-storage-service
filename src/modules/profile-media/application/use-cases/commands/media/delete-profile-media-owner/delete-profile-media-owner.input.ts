import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';

/** Authenticated terminal owner deletion fact. */
export interface DeleteProfileMediaOwnerInput {
  // #region Properties
  /** Scoped operation or value. */
  readonly owner: ProfileMediaOwnerBinding;
  // #endregion
}
