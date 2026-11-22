import type { AttachmentObjectRetention } from '../../../../models/attachment/attachment-object-retention.model.js';

/** Idempotent removal of private objects, called outside database transactions. */
export interface AttachmentObjectEraser {
  // #region Methods
  /** Removes an object; an already missing object is a successful removal. */
  deleteObject(objectKey: string, retention: AttachmentObjectRetention): Promise<void>;
  // #endregion
}
