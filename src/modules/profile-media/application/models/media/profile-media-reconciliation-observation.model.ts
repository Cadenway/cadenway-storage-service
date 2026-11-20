/** A ledger identity resolved from an opaque physical profile object. */
export interface ProfileMediaReconciliationObservation {
  // #region Properties
  /** Exact physical and owner identity needed for a scoped recheck. */
  readonly role: 'staging' | 'candidate';
  readonly objectId: string;
  readonly uploadId: string;
  readonly kind: 'avatar' | 'organization-logo';
  readonly ownerId: string;
  // #endregion
}
