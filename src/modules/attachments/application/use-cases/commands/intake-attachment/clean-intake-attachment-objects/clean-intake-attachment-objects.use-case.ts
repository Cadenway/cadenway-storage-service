import type { ObjectErasureResult } from '../../../../models/attachment/object-erasure-result.model.js';
import type { IntakeAttachmentObjectEraser } from '../../../../ports/outbound/object-storage/intake-attachment/intake-attachment-object-eraser.port.js';
import type { IntakeAttachmentCleanupUnitOfWork } from '../../../../ports/outbound/transactions/intake-attachment/intake-attachment-cleanup-unit-of-work.port.js';
import type { CleanAttachmentObjectsInput } from '../../attachment/clean-attachment-objects/clean-attachment-objects.input.js';
import type { CleanAttachmentObjectsOutput } from '../../attachment/clean-attachment-objects/clean-attachment-objects.output.js';

// One bounded page fits inside the cleanup lease at the configured storage deadline.
const BATCH_SIZE = 50;

/** Removes durably fenced anonymous attachment objects outside their transaction. */
export class CleanIntakeAttachmentObjects {
  // #region Constructor
  /** Binds the tenant transaction and idempotent object eraser. */
  public constructor(
    private readonly work: IntakeAttachmentCleanupUnitOfWork,
    private readonly objects: IntakeAttachmentObjectEraser,
  ) {}
  // #endregion

  // #region Methods
  /** Fences one page before deletion and confirms only its current generations. */
  public async execute(input: CleanAttachmentObjectsInput): Promise<CleanAttachmentObjectsOutput> {
    input.signal.throwIfAborted();
    const page = await this.work.run(input.organizationId, (store) =>
      store.fenceDueObjects(input.cutoff, input.after, BATCH_SIZE),
    );
    const results: ObjectErasureResult[] = [];
    let failed = 0;
    for (const object of page.objects) {
      if (input.signal.aborted) break;
      try {
        await this.objects.deleteIntakeObject({
          organizationId: input.organizationId,
          objectKey: object.objectKey,
          retention: object.retention,
        });
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
