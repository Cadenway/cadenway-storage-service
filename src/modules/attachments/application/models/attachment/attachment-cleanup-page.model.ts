import type { Attachment } from '../../../domain/aggregates/attachment/attachment.aggregate.js';
import type { CleanupCursor } from './cleanup-cursor.model.js';
import type { FencedCleanupObject } from './fenced-cleanup-object.model.js';

/** A bounded scan page and the durable fences obtained from its candidates. */
export interface AttachmentCleanupPage {
  // #region Properties
  /** Objects safe to erase after the transaction commits. */
  readonly objects: readonly FencedCleanupObject[];

  /** Locked pending reservations associated with the claimed objects. */
  readonly pendingAttachments: readonly Attachment[];

  /** Last scanned position when another page may remain. */
  readonly next: CleanupCursor | null;
  // #endregion
}
