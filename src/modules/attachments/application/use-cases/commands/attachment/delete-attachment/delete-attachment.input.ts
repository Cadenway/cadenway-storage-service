/** Verified caller and optional conditional version for an attachment deletion. */
export interface DeleteAttachmentInput {
  // #region Properties
  /** Verified tenant, actor and target. */
  readonly organizationId: string;
  readonly actorId: string;
  readonly taskKey: string;
  readonly attachmentId: string;

  /** Version parsed from an optional strong entity tag. */
  readonly expectedVersion?: number;
  // #endregion
}
