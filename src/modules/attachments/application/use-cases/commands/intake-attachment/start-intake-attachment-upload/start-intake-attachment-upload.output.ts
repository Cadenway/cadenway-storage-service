import type { UploadCapability } from '../../../../models/attachment/upload-capability.model.js';

/** The original signed capability, including its original expiry on replay. */
export interface StartIntakeAttachmentUploadOutput {
  // #region Properties
  /** Signed upload response and whether an existing response was returned. */
  readonly capability: UploadCapability;
  readonly replayed: boolean;
  // #endregion
}
