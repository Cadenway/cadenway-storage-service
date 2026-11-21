import type { UploadCapability } from '../../../../models/attachment/upload-capability.model.js';

/** A newly issued or replayed upload capability. */
export interface StartAttachmentUploadOutput {
  // #region Properties
  /** Original signed response and replay indicator. */
  readonly capability: UploadCapability;
  readonly replayed: boolean;
  // #endregion
}
