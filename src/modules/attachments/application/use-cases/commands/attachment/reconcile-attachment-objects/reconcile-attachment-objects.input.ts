/** Cancellation boundary for one scheduled inventory page. */
export interface ReconcileAttachmentObjectsInput {
  // #region Properties
  /** Cancels the inventory request and skips completion if the job stops. */
  readonly signal: AbortSignal;
  // #endregion
}
