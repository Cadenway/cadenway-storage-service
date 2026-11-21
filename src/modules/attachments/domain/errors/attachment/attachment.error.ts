import { DomainError } from './domain.error.js';

/** Carries a stable refusal reason without file metadata or object locations. */
export class AttachmentError extends DomainError {
  // #region Constructor
  /** Creates a refusal the application can map to the operation's contract. */
  public constructor(
    public readonly reason:
      | 'invalid-identity'
      | 'invalid-object-key'
      | 'invalid-file-name'
      | 'invalid-content-type'
      | 'invalid-size'
      | 'file-too-large'
      | 'invalid-state'
      | 'upload-expired'
      | 'upload-metadata-mismatch'
      | 'upload-not-ready'
      | 'attachment-deleted',
  ) {
    super(reason);
    this.name = 'AttachmentError';
  }
  // #endregion
}
