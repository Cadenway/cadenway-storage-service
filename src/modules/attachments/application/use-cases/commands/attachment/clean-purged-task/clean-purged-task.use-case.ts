import type { AttachmentRuntime } from '../../../../ports/outbound/runtime/attachment/attachment-runtime.port.js';
import type { AttachmentCleanupUnitOfWork } from '../../../../ports/outbound/transactions/attachment/attachment-cleanup-unit-of-work.port.js';
import type { CleanPurgedTaskInput } from './clean-purged-task.input.js';
import type { CleanPurgedTaskOutput } from './clean-purged-task.output.js';

const BATCH_SIZE = 500;

/** Removes at most one bounded batch of attachments belonging to a permanently purged task. */
export class CleanPurgedTask {
  // #region Constructor
  /** Binds the tenant transaction and clock. */
  public constructor(
    private readonly work: AttachmentCleanupUnitOfWork,
    private readonly runtime: AttachmentRuntime,
  ) {}
  // #endregion

  // #region Methods
  /** Persists lifecycle changes, object cleanup and deletion facts in one tenant transaction. */
  public execute(input: CleanPurgedTaskInput): Promise<CleanPurgedTaskOutput> {
    return this.work.run(input.organizationId, async (store) => {
      const actor = await store.lockPendingPurge(input.taskKey);
      if (actor === null) return { processed: 0, more: false };

      const attachments = await store.lockPurgeAttachments(input.taskKey, BATCH_SIZE);
      const now = this.runtime.now();
      for (const attachment of attachments) {
        if (attachment.snapshot.status === 'pending') {
          await store.deleteAttachment(attachment.discard(now));
        } else if (attachment.snapshot.status === 'ready') {
          const change = attachment.delete(now);
          await store.deleteAttachment(change.attachment);
          if (change.event !== null) await store.appendFact(change.event, actor);
        }
      }
      const more = attachments.length === BATCH_SIZE;
      if (!more) await store.finishPurge(input.taskKey);
      return { processed: attachments.length, more };
    });
  }
  // #endregion
}
