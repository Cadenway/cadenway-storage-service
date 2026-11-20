/** Tenant and authoritative Task release from a validated event. */
export interface ReleaseIntakeAttachmentInput {
  // #region Properties
  /** Task-owned reservation identity. */
  readonly organizationId: string;
  readonly publicationId: string;
  readonly attachmentId: string;
  // #endregion
}
