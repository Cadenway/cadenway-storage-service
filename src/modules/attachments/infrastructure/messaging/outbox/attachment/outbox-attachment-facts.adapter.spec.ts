import {
  eventSchemas,
  FILE_DELETED_V1,
  FILE_UPLOADED_V1,
} from '@cadenway/contracts/events/storage-service';
import type { TransactionScope } from '@cadenway/nest-common/database';
import type { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import { describe, expect, it, vi } from 'vitest';

import type { AttachmentFact } from '../../../../domain/events/attachment/attachment-fact.event.js';
import { createAttachmentFactWriter } from './outbox-attachment-facts.adapter.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const fileId = '019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e03';
const id = '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d30';
const occurredAt = '2026-11-20T14:02:00Z';

function fixture() {
  const append = vi.fn<OutboxWriter['append']>().mockResolvedValue({ id, occurredAt });
  const scope = { kind: 'tenant', organizationId } as TransactionScope;
  return { scope, append, write: createAttachmentFactWriter({ append }) };
}

describe('attachment outbox facts', () => {
  it.each([
    {
      type: FILE_UPLOADED_V1,
      version: 1,
      actor: { type: 'user', id: '019a5f3c-9e1f-7b2a-8c3d-4e5f6a7b8c31' },
    },
    { type: FILE_DELETED_V1, version: 2, actor: { type: 'system', id: 'task-service' } },
  ] as const)(
    'appends $type with its actor and revision in the caller transaction',
    async (test) => {
      const { scope, append, write } = fixture();
      const fact: AttachmentFact = {
        type: test.type,
        version: test.version,
        occurredAt,
        organizationId,
        fileId,
        taskKey: 'CAD-482',
        sizeBytes: 84216,
      };

      await write(scope, fact, test.actor);

      expect(append).toHaveBeenCalledExactlyOnceWith(scope, eventSchemas, test.type, {
        organizationId,
        actor: test.actor,
        version: test.version,
        fileId,
        taskKey: 'CAD-482',
        sizeBytes: 84216,
      });
      const data = append.mock.calls[0]?.[3];
      expect(eventSchemas[test.type].safeParse({ ...data, id, occurredAt }).success).toBe(true);
    },
  );

  it('refuses facts outside the owning tenant transaction', async () => {
    const { scope, append, write } = fixture();
    const fact: AttachmentFact = {
      type: FILE_DELETED_V1,
      version: 2,
      occurredAt,
      organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30',
      fileId,
      taskKey: 'CAD-482',
      sizeBytes: 84216,
    };

    await expect(write(scope, fact, { type: 'system', id: 'task-service' })).rejects.toThrow(
      'Attachment facts require the owning tenant transaction.',
    );
    expect(append).not.toHaveBeenCalled();
  });
});
