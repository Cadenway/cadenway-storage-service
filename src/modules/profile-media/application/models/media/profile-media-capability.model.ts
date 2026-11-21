/** The original signed transfer, returned only to its authorized uploader. */
export interface ProfileMediaCapability {
  // #region Properties
  /** Scoped operation or value. */
  readonly uploadId: string;
  readonly method: 'POST';
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly expiresAt: string;
  // #endregion
}
