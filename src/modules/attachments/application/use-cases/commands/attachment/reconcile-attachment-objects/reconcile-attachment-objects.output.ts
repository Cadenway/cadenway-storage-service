/** Number of physical objects that returned to the erasure queue. */
export interface ReconcileAttachmentObjectsOutput {
  // #region Properties
  /** Number of previously cleaned objects sent back to routine erasure. */
  readonly requeued: number;
  // #endregion
}
