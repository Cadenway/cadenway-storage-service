import { DomainError } from './domain.error.js';

/** Carries a refusal without asset data, object locations or credentials. */
export class ProfileMediaError extends DomainError {
  // #region Constructor
  /** Constructs a reason that an application can map to the installed Storage contract. */
  public constructor(
    public readonly reason:
      | 'invalid-identity'
      | 'invalid-state'
      | 'not-found'
      | 'file-too-large'
      | 'unsupported-type'
      | 'invalid-image'
      | 'key-reused'
      | 'request-in-progress'
      | 'upload-expired'
      | 'upload-not-ready'
      | 'upload-superseded',
  ) {
    super(reason);
    this.name = 'ProfileMediaError';
  }
  // #endregion
}
