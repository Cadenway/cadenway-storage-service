import {
  eventSchemas,
  INTAKE_ATTACHMENT_VERIFIED_V1,
} from '@cadenway/contracts/events/storage-service';
import type { TransactionScope } from '@cadenway/nest-common/database';
import type { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';

import type { IntakeAttachmentVerified } from '../../../../domain/events/intake-attachment/intake-attachment-verified.event.js';

/** Writes only the reservation identity in the same transaction that pins the verified object. */
export async function writeIntakeAttachmentVerification(
  outbox: Pick<OutboxWriter, 'append'>,
  scope: TransactionScope,
  fact: IntakeAttachmentVerified,
): Promise<void> {
  const organizationId = scope.organizationId;
  if (
    scope.kind !== 'tenant' ||
    organizationId?.toLowerCase() !== fact.organizationId.toLowerCase()
  )
    throw new Error('Intake verification facts require the owning tenant transaction.');

  await outbox.append(scope, eventSchemas, INTAKE_ATTACHMENT_VERIFIED_V1, {
    organizationId,
    actor: { type: 'system', id: 'storage-service' },
    version: fact.version,
    publicationId: fact.publicationId,
    attachmentId: fact.attachmentId,
  });
}
