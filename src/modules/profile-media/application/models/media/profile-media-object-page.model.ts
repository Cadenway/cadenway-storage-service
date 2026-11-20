/** A page of opaque physical identities to resolve in the service-owned ledger. */
export interface ProfileMediaObjectPage {
  // #region Properties
  /** The object kind and UUID encoded in each private S3 key. */
  readonly objects: readonly {
    readonly role: 'staging' | 'candidate';
    readonly objectId: string;
  }[];

  /** The next provider token, or null once the scan completes. */
  readonly next: string | null;
  // #endregion
}
