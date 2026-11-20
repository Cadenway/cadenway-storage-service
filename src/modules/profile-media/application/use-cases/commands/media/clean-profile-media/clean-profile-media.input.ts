/** Optional job cancellation before starting another physical deletion. */
export interface CleanProfileMediaInput {
  // #region Properties
  /** Stops the current job without acknowledging unprocessed leases. */
  readonly signal?: AbortSignal;
  // #endregion
}
