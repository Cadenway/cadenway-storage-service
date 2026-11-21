/** Organization-scoped usage page options. */
export interface ListLargestAttachmentsInput {
  // #region Properties
  /** Verified organization and keyset page. */
  readonly organizationId: string;
  readonly cursor: string | null;
  readonly limit: number;
  // #endregion
}
