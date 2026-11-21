import { eventSchemas } from '@cadenway/contracts/events/storage-service';
import type { EventPayloads } from '@cadenway/contracts/events/storage-service';
import type { TransactionScope } from '@cadenway/nest-common/database';
import type { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';

import type { AttachmentActor } from '../../../../application/models/attachment/attachment-actor.model.js';
import type { AttachmentFact } from '../../../../domain/events/attachment/attachment-fact.event.js';

type WriteFact = (
  scope: TransactionScope,
  fact: AttachmentFact,
  actor: AttachmentActor,
) => Promise<void>;

/** Writes the attachment revision and its verified byte count in the caller's tenant transaction. */
export function createAttachmentFactWriter(outbox: Pick<OutboxWriter, 'append'>): WriteFact {
  return async (scope, fact, actor) => {
    const organizationId = scope.organizationId;
    if (
      scope.kind !== 'tenant' ||
      organizationId?.toLowerCase() !== fact.organizationId.toLowerCase()
    ) {
      throw new Error('Attachment facts require the owning tenant transaction.');
    }

    const data: Omit<EventPayloads[AttachmentFact['type']], 'id' | 'occurredAt'> = {
      organizationId,
      actor: { type: actor.type, id: actor.id },
      version: fact.version,
      fileId: fact.fileId,
      taskKey: fact.taskKey,
      sizeBytes: fact.sizeBytes,
    };
    await outbox.append(scope, eventSchemas, fact.type, data);
  };
}
