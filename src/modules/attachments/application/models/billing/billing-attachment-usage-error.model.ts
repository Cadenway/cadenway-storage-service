/** Refuses an invalid Billing continuation or an unavailable cursor signer. */
export class BillingAttachmentUsageError extends Error {
  // #region Constructor
  /** Carries the refusal category without retaining the supplied cursor. */
  public constructor(public readonly reason: 'invalid-cursor' | 'unavailable') {
    super(reason);
  }
  // #endregion
}
