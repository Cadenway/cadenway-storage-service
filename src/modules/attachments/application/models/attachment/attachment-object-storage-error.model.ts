/** A storage failure whose message can be reported without disclosing provider details. */
export class AttachmentObjectStorageError extends Error {
  // #region Constructor
  /** Provides a stable message for application callers. */
  public constructor() {
    super('Object storage could not process the attachment.');
    this.name = 'AttachmentObjectStorageError';
  }
  // #endregion
}
