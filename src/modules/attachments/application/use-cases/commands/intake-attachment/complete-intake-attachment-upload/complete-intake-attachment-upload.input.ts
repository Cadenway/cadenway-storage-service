/** The Task-authorized reservation in the signed tenant context. */
export interface CompleteIntakeAttachmentUploadInput {
  // #region Properties
  /** Verified tenant and exact publication/attachment allocation. */
  readonly organizationId: string;
  readonly publicationId: string;
  readonly attachmentId: string;
  // #endregion
}
