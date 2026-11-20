/** Trusted inputs that apply to a complete scheduled attachment sweep. */
export interface SweepAttachmentCleanupInput {
  // #region Properties
  /** Object eligibility timestamp shared by every page and tenant. */
  readonly cutoff: Date;

  /** Cancellation of the current job attempt. */
  readonly signal: AbortSignal;

  /** Runs a command in the tenant context established from a discovered Storage row. */
  readonly inOrganization: <T>(organizationId: string, work: () => Promise<T>) => Promise<T>;
  // #endregion
}
