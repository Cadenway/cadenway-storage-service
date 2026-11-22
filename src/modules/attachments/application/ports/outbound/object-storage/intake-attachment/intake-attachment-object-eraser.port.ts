import type { AttachmentObjectRetention } from '../../../../models/attachment/attachment-object-retention.model.js';

/** Removes a fenced anonymous upload object in its verified tenant context. */
export interface IntakeAttachmentObjectEraser {
  // #region Methods
  /** Deletes the authorized opaque staging key or tenant-scoped candidate. */
  deleteIntakeObject(input: {
    readonly organizationId: string;
    readonly objectKey: string;
    readonly retention: AttachmentObjectRetention;
  }): Promise<void>;
  // #endregion
}
