/** Server-observed metadata and content verification for the immutable finalized object. */
export interface AttachmentVerification {
  // #region Properties
  /** Exact size in bytes reported by object storage. */
  readonly sizeBytes: number;

  /** Object-store media type, or null if absent. */
  readonly contentType: string | null;

  /** Media type established by content verification, or null if unverified. */
  readonly verifiedContentType: string | null;
  // #endregion
}
