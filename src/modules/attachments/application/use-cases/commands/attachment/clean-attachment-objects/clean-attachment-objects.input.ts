import type { CleanupCursor } from '../../../../models/attachment/cleanup-cursor.model.js';

/** One page of a tenant-scoped cleanup sweep. */
export interface CleanAttachmentObjectsInput {
  // #region Properties
  /** Organization from the job's verified context. */
  readonly organizationId: string;

  /** Eligibility cutoff shared by the sweep. */
  readonly cutoff: Date;

  /** Last position, or null at the start. */
  readonly after: CleanupCursor | null;

  /** Stops work between external operations. */
  readonly signal: AbortSignal;
  // #endregion
}
