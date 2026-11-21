/** Task-scoped page options validated at the HTTP boundary. */
export interface ListAttachmentsInput {
  // #region Properties
  /** Verified tenant, task and keyset page. */
  readonly organizationId: string;
  readonly taskKey: string;
  readonly cursor: string | null;
  readonly limit: number;
  // #endregion
}
