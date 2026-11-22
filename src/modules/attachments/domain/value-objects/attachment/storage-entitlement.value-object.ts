/** The Billing entitlement version and its local verified-byte ceiling. */
export interface StorageEntitlement {
  // #region Properties
  /** Billing's monotonic entitlement version, with zero for legacy Free. */
  readonly version: number;

  /** Exact verified attachment byte limit. */
  readonly limitBytes: bigint;
  // #endregion
}
