import type { ObjectErasureResult } from '../../../../models/attachment/object-erasure-result.model.js';
import type { AttachmentObjectEraser } from '../../../../ports/outbound/object-storage/attachment/attachment-object-eraser.port.js';
import type { AttachmentCleanupUnitOfWork } from '../../../../ports/outbound/transactions/attachment/attachment-cleanup-unit-of-work.port.js';
import type { CleanAttachmentObjectsInput } from './clean-attachment-objects.input.js';
import type { CleanAttachmentObjectsOutput } from './clean-attachment-objects.output.js';

// One page fits the 15-minute lease even at the configured deadline for every storage call.
const BATCH_SIZE = 50;

/** Removes one page of durably fenced objects outside the fencing transaction. */
export class CleanAttachmentObjects {
  // #region Constructor
  /** Binds the tenant transaction and idempotent object eraser. */
  public constructor(
    private readonly work: AttachmentCleanupUnitOfWork,
    private readonly objects: AttachmentObjectEraser,
  ) {}
  // #endregion

  // #region Methods
  /** Commits the cleanup leases before erasing objects and confirms results in a second transaction. */
  public async execute(input: CleanAttachmentObjectsInput): Promise<CleanAttachmentObjectsOutput> {
    input.signal.throwIfAborted();
    const page = await this.work.run(input.organizationId, async (store) => {
      const claimed = await store.fenceDueObjects(input.cutoff, input.after, BATCH_SIZE);
      for (const attachment of claimed.pendingAttachments) {
        const expired = attachment.expire(input.cutoff);
        if (expired !== attachment) await store.deleteAttachment(expired);
      }
      return claimed;
    });
    const results: ObjectErasureResult[] = [];
    let failed = 0;
    for (const object of page.objects) {
      if (input.signal.aborted) break;
      try {
        await this.objects.deleteObject(object.objectKey, object.retention);
        results.push({ ...object, erased: true });
      } catch {
        results.push({ ...object, erased: false });
        failed += 1;
      }
    }
    const processed =
      results.length === 0
        ? 0
        : await this.work.run(input.organizationId, (store) => store.settleObjectErasures(results));
    input.signal.throwIfAborted();
    return { processed, failed, next: page.next };
  }
  // #endregion
}
