/** Position in a tenant's ordered object cleanup sweep. */
export interface CleanupCursor {
  // #region Properties
  /** Original eligibility time in the sweep. */
  readonly cleanupAfter: Date;

  /** Unique key within the organization. */
  readonly objectKey: string;
  // #endregion
}
