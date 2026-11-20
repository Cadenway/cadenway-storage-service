/** Fixed upper file ID and the last returned file ID of a Search export. */
export interface AttachmentSearchProjectionPosition {
  // #region Properties
  /** Inclusive upper ID fixed by the first page. */
  readonly upperFileId: string;

  /** Exclusive lower ID returned last in the previous page. */
  readonly afterFileId: string;
  // #endregion
}
