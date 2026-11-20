/** Clock and unique object identifiers needed by attachment lifecycle operations. */
export interface AttachmentRuntime {
  // #region Methods
  /** Current application time. */
  now(): Date;

  /** Allocates a database UUIDv7 suitable for an attachment or object key. */
  newId(): Promise<string>;
  // #endregion
}
