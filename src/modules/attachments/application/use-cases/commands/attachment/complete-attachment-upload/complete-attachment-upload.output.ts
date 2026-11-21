import type { AttachmentView } from '../../../../models/attachment/attachment-view.model.js';

/** The ready attachment after a completion or its replay. */
export interface CompleteAttachmentUploadOutput {
  // #region Properties
  /** Public metadata of the accepted object. */
  readonly attachment: AttachmentView;
  // #endregion
}
