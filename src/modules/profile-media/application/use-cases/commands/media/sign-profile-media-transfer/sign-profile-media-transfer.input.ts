import type { ProfileMediaTransfer } from '../../../../../domain/value-objects/media/profile-media-transfer.value-object.js';

/** The owner-authorized declaration and optional cancellation. */
export interface SignProfileMediaTransferInput extends ProfileMediaTransfer {
  // #region Properties
  /** Scoped operation or value. */
  readonly signal?: AbortSignal;
  // #endregion
}
