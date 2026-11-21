/** The fixed upper file ID and the exclusive lower ID for a resumed usage scan. */
export interface BillingAttachmentUsagePosition {
  // #region Properties
  /** Highest eligible file ID captured on the first page. */
  readonly upperId: string;

  /** Last file ID returned on the preceding page. */
  readonly afterId: string;
  // #endregion
}
