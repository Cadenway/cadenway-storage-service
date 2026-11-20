/** Number of objects successfully reclaimed in one bounded pass. */
export interface CleanProfileMediaOutput {
  // #region Properties
  /** Successful idempotent physical deletions and acknowledged leases. */
  readonly deleted: number;
  // #endregion
}
