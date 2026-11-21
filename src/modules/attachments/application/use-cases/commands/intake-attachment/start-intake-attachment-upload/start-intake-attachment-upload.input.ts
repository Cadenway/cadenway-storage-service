/** Trusted allocation and declaration supplied by the API gateway. */
export interface StartIntakeAttachmentUploadInput {
  // #region Properties
  /** Organization from the signed context and Task-owned allocation identifiers. */
  readonly organizationId: string;
  readonly publicationId: string;
  readonly attachmentId: string;

  /** Draft expiry and declared file metadata fixed by the Task allocation. */
  readonly expiresAt: Date;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  // #endregion
}
