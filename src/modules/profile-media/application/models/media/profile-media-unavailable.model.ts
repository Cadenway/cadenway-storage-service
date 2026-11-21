/** Signals a retryable signing or storage operation without disclosing private object data. */
export class ProfileMediaUnavailable extends Error {
  // #region Constructor
  /** Binds this operation's collaborators. */
  public constructor() {
    super('Profile media is temporarily unavailable.');
    this.name = 'ProfileMediaUnavailable';
  }
  // #endregion
}
