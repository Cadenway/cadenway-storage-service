import { AttachmentRefusal } from '../../../../models/attachment/attachment-refusal.model.js';
import type { AttachmentRuntime } from '../../../../ports/outbound/runtime/attachment/attachment-runtime.port.js';
import type { AttachmentUnitOfWork } from '../../../../ports/outbound/transactions/attachment/attachment-unit-of-work.port.js';
import type { DeleteAttachmentInput } from './delete-attachment.input.js';
import type { DeleteAttachmentOutput } from './delete-attachment.output.js';

/** Tombstones a ready attachment, records cleanup and appends its fact together. */
export class DeleteAttachment {
  // #region Constructor
  /** Binds the transaction and clock. */
  public constructor(
    private readonly work: AttachmentUnitOfWork,
    private readonly runtime: AttachmentRuntime,
  ) {}
  // #endregion

  // #region Methods
  /** Deletes one ready attachment of the verified task. */
  public execute(input: DeleteAttachmentInput): Promise<DeleteAttachmentOutput> {
    return this.work.run(input.organizationId, async (store) => {
      if (await store.lockTask(input.taskKey)) throw new AttachmentRefusal('not-found');
      const attachment = await store.lockAttachment(input.taskKey, input.attachmentId);
      if (attachment?.snapshot.status !== 'ready') {
        throw new AttachmentRefusal('not-found');
      }
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== attachment.snapshot.version
      ) {
        throw new AttachmentRefusal('version-mismatch');
      }
      const change = attachment.delete(this.runtime.now());
      if (change.event !== null) {
        await store.deleteAttachment(change.attachment);
        await store.appendFact(change.event, { type: 'user', id: input.actorId });
      }
      return undefined;
    });
  }
  // #endregion
}
