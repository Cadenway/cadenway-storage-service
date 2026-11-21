import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';

/** Exact owner, uploader and upload established by the verified request. */
export interface PrepareProfileMediaInput {
  // #region Properties
  /** Scoped operation or value. */
  readonly owner: ProfileMediaOwnerBinding;
  readonly uploaderUserId: string;
  readonly uploadId: string;
  readonly signal?: AbortSignal;
  // #endregion
}
