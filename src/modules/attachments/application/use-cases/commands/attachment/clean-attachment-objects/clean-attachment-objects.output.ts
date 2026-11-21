import type { CleanupCursor } from '../../../../models/attachment/cleanup-cursor.model.js';

/** Resume position for one completed page. */
export interface CleanAttachmentObjectsOutput {
  // #region Properties
  /** Number of erasures durably confirmed for this page. */
  readonly processed: number;

  /** Number of erasures to retry from their durable fences. */
  readonly failed: number;

  /** Next position, or null when this sweep completes. */
  readonly next: CleanupCursor | null;
  // #endregion
}
