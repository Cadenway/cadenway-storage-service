import type { CleanupCursor } from '../../../../models/attachment/cleanup-cursor.model.js';
import type { FencedCleanupObject } from '../../../../models/attachment/fenced-cleanup-object.model.js';
import type { ObjectErasureResult } from '../../../../models/attachment/object-erasure-result.model.js';

/** Cleanup operations sharing an Intake tenant transaction. */
export interface IntakeAttachmentCleanupTransaction {
  // #region Methods
  /**
   * Scans a bounded page and fences eligible objects under the reservation lock. Protected
   * verified or claimed candidates and staging keys with live upload capabilities stay intact.
   * The cursor includes examined candidates even when a concurrent decision skips them.
   */
  fenceDueObjects(
    cutoff: Date,
    after: CleanupCursor | null,
    limit: number,
  ): Promise<{
    readonly objects: readonly FencedCleanupObject[];
    readonly next: CleanupCursor | null;
  }>;

  /** Settles only results matching the current cleanup generation. */
  settleObjectErasures(results: readonly ObjectErasureResult[]): Promise<number>;
  // #endregion
}
