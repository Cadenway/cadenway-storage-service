/** Resolves media types for attachment basenames. */
export interface AttachmentMediaTypeLookup {
  // #region Methods
  /** Returns the registered type for the final extension, if known. */
  lookup(fileName: string): string | null;
  // #endregion
}
