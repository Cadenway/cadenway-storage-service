/** Temporary browser-facing download capability. */
export interface GetAttachmentDownloadOutput {
  // #region Properties
  /** Signed URL and exclusive expiry. */
  readonly url: string;
  readonly expiresAt: string;
  // #endregion
}
