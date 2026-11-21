/** Result of one committed batch. */
export interface CleanPurgedTaskOutput {
  // #region Properties
  /** Number processed in this transaction. */
  readonly processed: number;

  /** Whether another batch may remain. */
  readonly more: boolean;
  // #endregion
}
