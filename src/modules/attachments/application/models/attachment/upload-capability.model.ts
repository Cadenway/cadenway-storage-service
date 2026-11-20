/** The signed multipart upload capability returned only to the verified caller. */
export interface UploadCapability {
  // #region Properties
  /** The reserved attachment. */
  readonly id: string;

  /** Browser-facing signed POST destination. */
  readonly method: 'POST';
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;

  /** Exclusive expiry of the upload capability. */
  readonly expiresAt: string;
  // #endregion
}
