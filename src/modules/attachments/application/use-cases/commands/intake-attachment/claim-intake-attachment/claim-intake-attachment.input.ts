/** Tenant and authoritative Task decision from a validated event. */
export interface ClaimIntakeAttachmentInput {
  // #region Properties
  /** Task-owned reservation identity and resulting stable task key. */
  readonly organizationId: string;
  readonly publicationId: string;
  readonly attachmentId: string;
  readonly taskKey: string;
  // #endregion
}
