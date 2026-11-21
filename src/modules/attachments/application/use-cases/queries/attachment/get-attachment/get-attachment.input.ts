/** Verified tenant and task identity for a ready attachment read. */
export interface GetAttachmentInput {
  // #region Properties
  /** The authorized scope and target. */
  readonly organizationId: string;
  readonly taskKey: string;
  readonly attachmentId: string;
  // #endregion
}
