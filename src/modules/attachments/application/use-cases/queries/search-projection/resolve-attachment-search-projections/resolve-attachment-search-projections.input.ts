/** One ordered batch of unique file IDs in the verified organization. */
export interface ResolveAttachmentSearchProjectionsInput {
  // #region Properties
  /** Organization from the verified token. */
  readonly organizationId: string;

  /** Canonical attachment UUIDs in request order. */
  readonly fileIds: readonly string[];
  // #endregion
}
