/** A reservation is identified by its signed tenant and Task allocation. */
export interface IntakeAttachmentIdentity {
  // #region Properties
  /** Tenant from the verified context and publication/attachment allocated by Task. */
  readonly organizationId: string;
  readonly publicationId: string;
  readonly attachmentId: string;
  // #endregion
}
