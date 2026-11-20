import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';

/** Owner-authenticated terminal abandonment. */
export interface AbandonProfileMediaInput {
  // #region Properties
  /** Scoped operation or value. */
  readonly owner: ProfileMediaOwnerBinding;
  readonly uploadId: string;
  // #endregion
}
