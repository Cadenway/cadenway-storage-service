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

  /** Verified uploader, or null for an anonymous intake attachment, and accepted instant. */
  readonly authorUserId: string | null;
  readonly uploadedAt: string;
  readonly version: number;
  // #endregion
}
