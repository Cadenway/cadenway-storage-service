/** Verified scope for a signed download. */
export interface GetAttachmentDownloadInput {
  // #region Properties
  /** The authorized tenant and attachment identity. */
  readonly organizationId: string;
  readonly taskKey: string;
  readonly attachmentId: string;
  // #endregion
}
