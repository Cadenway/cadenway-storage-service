/** Refuses an invalid continuation or an export without a configured cursor key. */
export class AttachmentSearchProjectionError extends Error {
  // #region Constructor
  /** Carries only the refusal category. */
  public constructor(public readonly reason: 'invalid-cursor' | 'unavailable') {
    super(reason);
  }
  // #endregion
}
