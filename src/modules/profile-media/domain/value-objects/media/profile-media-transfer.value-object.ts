import type { ProfileMediaOwnerBinding } from './profile-media-owner-binding.value-object.js';

/** Exact declaration already authorized by the owner before Storage signs a staged transfer. */
export interface ProfileMediaTransfer {
  // #region Properties
  /** Owner and reservation ID that will become the asset ID on adoption. */
  readonly owner: ProfileMediaOwnerBinding;
  readonly uploadId: string;

  /** Account allowed to sign and prepare this source. */
  readonly uploaderUserId: string;

  /** Declared encoding and exact byte length. */
  readonly contentType: string;
  readonly sizeBytes: number;

  /** Original exclusive deadline, preserved on repeats. */
  readonly expiresAt: Date;
  // #endregion
}
