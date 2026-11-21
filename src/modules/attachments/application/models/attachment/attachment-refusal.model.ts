/** A stable application refusal without object locations or capability values. */
export class AttachmentRefusal extends Error {
  // #region Constructor
  /** Names the failure to be mapped at the HTTP boundary. */
  public constructor(
    public readonly reason:
      | 'not-found'
      | 'upload-not-ready'
      | 'storage-quota-exceeded'
      | 'version-mismatch'
      | 'request-in-progress'
      | 'idempotency-key-reused',
  ) {
    super(reason);
    this.name = 'AttachmentRefusal';
  }
  // #endregion
}
