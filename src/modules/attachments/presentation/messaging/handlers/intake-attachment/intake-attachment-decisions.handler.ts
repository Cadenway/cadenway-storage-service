import {
  eventSchemas,
  INTAKE_ATTACHMENT_CLAIMED_V1,
  INTAKE_ATTACHMENT_RELEASED_V1,
} from '@cadenway/contracts/events/task-service';
import type {
  IntakeAttachmentClaimedV1,
  IntakeAttachmentReleasedV1,
} from '@cadenway/contracts/events/task-service';
import { requireOrganizationId } from '@cadenway/nest-common';
import type { EventConsumers, EventContext } from '@cadenway/nest-messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';

import type { IntakeAttachmentIdentity } from '../../../../application/models/intake-attachment/intake-attachment-identity.model.js';
import type { ClaimIntakeAttachment } from '../../../../application/use-cases/commands/intake-attachment/claim-intake-attachment/claim-intake-attachment.use-case.js';
import type { ReleaseIntakeAttachment } from '../../../../application/use-cases/commands/intake-attachment/release-intake-attachment/release-intake-attachment.use-case.js';

/** Validates Task's actor and the tenant established by the kit's deduplication transaction. */
function intakeDecisionIdentity(
  fact: IntakeAttachmentClaimedV1 | IntakeAttachmentReleasedV1,
  { signal }: EventContext,
): IntakeAttachmentIdentity {
  signal.throwIfAborted();
  const organizationId = requireOrganizationId();
  if (
    organizationId.toLowerCase() !== fact.organizationId.toLowerCase() ||
    fact.actor.type !== 'system' ||
    fact.actor.id !== 'task-service'
  ) {
    throw new Error('The intake decision requires its tenant and the Task system actor.');
  }
  return {
    organizationId: organizationId.toLowerCase(),
    publicationId: fact.publicationId.toLowerCase(),
    attachmentId: fact.attachmentId.toLowerCase(),
  };
}

/** Consumes the authoritative Task dispositions within the delivery deduplication transaction. */
export class IntakeAttachmentDecisionsHandler implements OnApplicationBootstrap {
  // #region Constructor
  /** Binds the retained Task decisions to the corresponding tenant operations. */
  public constructor(
    private readonly consumers: Pick<EventConsumers, 'subscribe'>,
    private readonly claim: Pick<ClaimIntakeAttachment, 'execute'>,
    private readonly release: Pick<ReleaseIntakeAttachment, 'execute'>,
  ) {}
  // #endregion

  // #region Methods
  /** Registers separate stable durable consumers for the two immutable terminal decisions. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.consumers.subscribe({
      handler: 'claim-intake-attachment',
      schemas: eventSchemas,
      event: INTAKE_ATTACHMENT_CLAIMED_V1,
      deliverPolicy: 'all',
      handle: async (fact, context) => {
        await this.claim.execute({
          ...intakeDecisionIdentity(fact, context),
          taskKey: fact.taskKey,
        });
        context.signal.throwIfAborted();
      },
    });
    await this.consumers.subscribe({
      handler: 'release-intake-attachment',
      schemas: eventSchemas,
      event: INTAKE_ATTACHMENT_RELEASED_V1,
      deliverPolicy: 'all',
      handle: async (fact, context) => {
        await this.release.execute(intakeDecisionIdentity(fact, context));
        context.signal.throwIfAborted();
      },
    });
  }
  // #endregion
}
