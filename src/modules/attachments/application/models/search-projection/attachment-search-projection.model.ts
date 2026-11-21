/** Search metadata for a ready attachment of a task. */
export interface AttachmentSearchProjection {
  // #region Properties
  /** Stable Storage attachment UUID. */
  readonly fileId: string;

  /** Key of the task that owns the attachment. */
  readonly taskKey: string;

  /** Original basename accepted by Storage's attachment policy. */
  readonly fileName: string;

  /** Version of the published attachment state. */
  readonly version: number;
  // #endregion
}
