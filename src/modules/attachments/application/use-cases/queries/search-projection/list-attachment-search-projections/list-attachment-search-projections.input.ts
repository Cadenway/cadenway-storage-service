/** A Search export page for the verified organization. */
export interface ListAttachmentSearchProjectionsInput {
  // #region Properties
  /** Organization from the verified token. */
  readonly organizationId: string;

  /** Opaque continuation, or null for the first page. */
  readonly cursor: string | null;

  /** Maximum count of ready projections to return. */
  readonly limit: number;
  // #endregion
}
