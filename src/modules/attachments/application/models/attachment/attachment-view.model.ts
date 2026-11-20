/** Ready attachment metadata without storage locations. */
export interface AttachmentView {
  // #region Properties
  /** Attachment and task identities. */
  readonly id: string;
  readonly taskKey: string;

  /** Display and file metadata. */
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;

  /** Verified uploader and accepted instant. */
  readonly authorUserId: string;
  readonly uploadedAt: string;
  readonly version: number;
  // #endregion
}
