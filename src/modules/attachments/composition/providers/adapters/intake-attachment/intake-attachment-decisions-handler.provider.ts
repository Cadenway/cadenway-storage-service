import { EventConsumers } from '@cadenway/nest-messaging';
import type { FactoryProvider } from '@nestjs/common';

import { ClaimIntakeAttachment } from '../../../../application/use-cases/commands/intake-attachment/claim-intake-attachment/claim-intake-attachment.use-case.js';
import { ReleaseIntakeAttachment } from '../../../../application/use-cases/commands/intake-attachment/release-intake-attachment/release-intake-attachment.use-case.js';
import { IntakeAttachmentDecisionsHandler } from '../../../../presentation/messaging/handlers/intake-attachment/intake-attachment-decisions.handler.js';

/** Wires Task's terminal facts to the tenant commands using the kit's transactional consumer. */
export const intakeAttachmentDecisionsHandlerProvider: FactoryProvider<IntakeAttachmentDecisionsHandler> =
  {
    provide: IntakeAttachmentDecisionsHandler,
    inject: [EventConsumers, ClaimIntakeAttachment, ReleaseIntakeAttachment],
    useFactory: (
      consumers: EventConsumers,
      claim: ClaimIntakeAttachment,
      release: ReleaseIntakeAttachment,
    ): IntakeAttachmentDecisionsHandler =>
      new IntakeAttachmentDecisionsHandler(consumers, claim, release),
  };
