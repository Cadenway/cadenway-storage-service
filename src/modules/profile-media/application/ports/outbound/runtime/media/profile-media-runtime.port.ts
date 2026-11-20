/** Clock and UUID allocation injected for deterministic transaction and expiry checks. */
export interface ProfileMediaRuntime {
  // #region Methods
  /** Scoped operation or value. */
  now(): Date;
  newId(): Promise<string>;
  // #endregion
}
