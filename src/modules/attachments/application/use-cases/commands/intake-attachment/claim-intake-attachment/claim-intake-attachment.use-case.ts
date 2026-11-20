import { IntakeAttachment } from '../../../../../domain/aggregates/intake-attachment/intake-attachment.aggregate.js';
import type { AttachmentRuntime } from '../../../../ports/outbound/runtime/attachment/attachment-runtime.port.js';
import type { IntakeAttachmentUnitOfWork } from '../../../../ports/outbound/transactions/intake-attachment/intake-attachment-unit-of-work.port.js';
import type { ClaimIntakeAttachmentInput } from './claim-intake-attachment.input.js';
import type { ClaimIntakeAttachmentOutput } from './claim-intake-attachment.output.js';

/** Applies the authoritative Task claim with the permanent task-purge fence. */
export class ClaimIntakeAttachment {
  // #region Constructor
  /** Binds the tenant transaction and clock. */
  public constructor(
    private readonly work: IntakeAttachmentUnitOfWork,
    private readonly runtime: AttachmentRuntime,
  ) {}
  // #endregion

  // #region Methods
  /** Locks Task before the allocation and records the attachment and fact together. */
  public execute(input: ClaimIntakeAttachmentInput): Promise<ClaimIntakeAttachmentOutput> {
    return this.work.run(input.organizationId, async (store) => {
      const purged = await store.lockTask(input.taskKey);
      const current = await store.lock(input);
      if (current === null) {
        const terminal = IntakeAttachment.claimUnallocated(
          {
            organizationId: input.organizationId,
            publicationId: input.publicationId,
            id: input.attachmentId,
          },
          input.taskKey,
          this.runtime.now(),
        );
        await store.saveDecision(input, terminal, null, null);
        return undefined;
      }
      const change = current.claim(input.taskKey, purged, this.runtime.now());
      if (change.intakeAttachment !== current) {
        await store.saveDecision(input, change.intakeAttachment, change.attachment, change.event);
      }
      return undefined;
    });
  }
  // #endregion
}
