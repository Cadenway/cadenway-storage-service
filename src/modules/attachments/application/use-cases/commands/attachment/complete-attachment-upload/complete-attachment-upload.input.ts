/** Verified caller and task identity for an upload completion. */
export interface CompleteAttachmentUploadInput {
  // #region Properties
  /** Tenant, actor, task and attachment to finalize. */
  readonly organizationId: string;
  readonly actorId: string;
  readonly taskKey: string;
  readonly attachmentId: string;
  // #endregion
}
