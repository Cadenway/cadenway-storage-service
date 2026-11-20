import { IntakeAttachment } from '../../../../../domain/aggregates/intake-attachment/intake-attachment.aggregate.js';
import type { AttachmentRuntime } from '../../../../ports/outbound/runtime/attachment/attachment-runtime.port.js';
import type { IntakeAttachmentUnitOfWork } from '../../../../ports/outbound/transactions/intake-attachment/intake-attachment-unit-of-work.port.js';
import type { ReleaseIntakeAttachmentInput } from './release-intake-attachment.input.js';
import type { ReleaseIntakeAttachmentOutput } from './release-intake-attachment.output.js';

/** Records Task's terminal release even before Storage receives the reservation. */
export class ReleaseIntakeAttachment {
  // #region Constructor
  /** Binds the tenant transaction and clock. */
  public constructor(
    private readonly work: IntakeAttachmentUnitOfWork,
    private readonly runtime: AttachmentRuntime,
  ) {}
  // #endregion

  // #region Methods
  /** Repeated releases converge on one durable cleanup decision. */
  public execute(input: ReleaseIntakeAttachmentInput): Promise<ReleaseIntakeAttachmentOutput> {
    return this.work.run(input.organizationId, async (store) => {
      const current = await store.lock(input);
      const next =
        current === null
          ? IntakeAttachment.releaseUnallocated(
              {
                organizationId: input.organizationId,
                publicationId: input.publicationId,
                id: input.attachmentId,
              },
              this.runtime.now(),
            )
          : current.release(this.runtime.now());
      if (next !== current) await store.saveDecision(input, next, null, null);
      return undefined;
    });
  }
  // #endregion
}
