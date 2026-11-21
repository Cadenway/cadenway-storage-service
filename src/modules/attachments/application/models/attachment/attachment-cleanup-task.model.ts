/** Stable position of a task whose attachments must be removed after a purge. */
export interface AttachmentCleanupTask {
  // #region Properties
  /** Organization that owns the pending task tombstone. */
  readonly organizationId: string;

  /** Stable task key recorded on the tombstone. */
  readonly taskKey: string;
  // #endregion
}
