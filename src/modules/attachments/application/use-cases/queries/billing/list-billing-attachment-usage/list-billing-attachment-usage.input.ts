/** A Billing usage page requested for the organization in the verified internal token. */
export interface ListBillingAttachmentUsageInput {
  // #region Properties
  /** Organization supplied by the verified request context. */
  readonly organizationId: string;

  /** Authenticated continuation from the preceding page, if any. */
  readonly cursor: string | null;

  /** Maximum number of attachment states to return. */
  readonly limit: number;
  // #endregion
}
