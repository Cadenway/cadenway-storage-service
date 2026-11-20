/** Identifies one short-lived owner of the current storage continuation. */
export interface AttachmentReconciliationLease {
  // #region Properties
  /** Ownership token renewed on each acquisition. */
  readonly id: string;

  /** The provider cursor currently persisted by Storage. */
  readonly continuation: string | null;
  // #endregion
}
