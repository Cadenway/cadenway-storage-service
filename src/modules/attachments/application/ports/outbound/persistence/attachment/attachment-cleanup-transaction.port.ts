import type { Attachment } from '../../../../../domain/aggregates/attachment/attachment.aggregate.js';
import type { AttachmentActor } from '../../../../models/attachment/attachment-actor.model.js';
import type { AttachmentCleanupPage } from '../../../../models/attachment/attachment-cleanup-page.model.js';
import type { AttachmentTransaction } from '../../../../models/attachment/attachment-transaction.model.js';
import type { CleanupCursor } from '../../../../models/attachment/cleanup-cursor.model.js';
import type { ObjectErasureResult } from '../../../../models/attachment/object-erasure-result.model.js';

/** Cleanup operations sharing a tenant-scoped database transaction. */
export interface AttachmentCleanupTransaction extends Pick<
  AttachmentTransaction,
  'deleteAttachment' | 'appendFact'
> {
  // #region Methods
  /** Locks an existing task tombstone and returns its original purge actor, if cleanup is pending. */
  lockPendingPurge(taskKey: string): Promise<AttachmentActor | null>;

  /** Locks at most limit non-deleted attachments for the locked task, ordered by ID. */
  lockPurgeAttachments(taskKey: string, limit: number): Promise<readonly Attachment[]>;

  /** Clears pending work for the locked tombstone after the last attachment has been processed. */
  finishPurge(taskKey: string): Promise<void>;

  /**
   * Scans at most limit due objects after the cursor, ordered by (cleanupAfter, objectKey).
   * Lock tasks before their attachments and lease eligible objects under fresh fence generations.
   * Return locked pending reservations for expiry checks within the same transaction.
   * The resume cursor covers every scanned candidate, including ones skipped after locking.
   */
  fenceDueObjects(
    cutoff: Date,
    after: CleanupCursor | null,
    limit: number,
  ): Promise<AttachmentCleanupPage>;

  /** Records current-generation results and returns the number of newly confirmed erasures. */
  settleObjectErasures(results: readonly ObjectErasureResult[]): Promise<number>;
  // #endregion
}
