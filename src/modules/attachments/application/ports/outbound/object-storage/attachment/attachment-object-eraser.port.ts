/** Idempotent removal of private objects, called outside database transactions. */
export interface AttachmentObjectEraser {
  // #region Methods
  /** Removes an object; an already missing object is a successful removal. */
  deleteObject(objectKey: string): Promise<void>;
  // #endregion
}
