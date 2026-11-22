/** The verified bytes and corresponding limit read after taking the same tenant lock. */
export interface StorageQuotaAdmission {
  // #region Properties
  /** Ready attachment bytes, verified Intake reservations, and staging bytes when requested. */
  readonly usedBytes: bigint;

  /** The accepted Billing ceiling or the Free baseline in bytes. */
  readonly limitBytes: bigint;
  // #endregion
}
