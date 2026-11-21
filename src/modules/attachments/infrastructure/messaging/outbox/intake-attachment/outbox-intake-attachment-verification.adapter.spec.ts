import {
  eventSchemas,
  INTAKE_ATTACHMENT_VERIFIED_V1,
} from '@cadenway/contracts/events/storage-service';
import type { TransactionScope } from '@cadenway/nest-common/database';
import type { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import { describe, expect, it, vi } from 'vitest';

import type { IntakeAttachmentVerified } from '../../../../domain/events/intake-attachment/intake-attachment-verified.event.js';
import { writeIntakeAttachmentVerification } from './outbox-intake-attachment-verification.adapter.js';

const id = '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d32';
const fact: IntakeAttachmentVerified = {
  type: INTAKE_ATTACHMENT_VERIFIED_V1,
  occurredAt: '2026-11-20T14:02:00Z',
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  version: 1,
  publicationId: '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f12',
  attachmentId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15',
};

describe('intake verification outbox', () => {
  it('stores only the allowed system fact through the pinning transaction', async () => {
    const organizationId = fact.organizationId.toUpperCase();
    const scope = { kind: 'tenant', organizationId } as TransactionScope;
    const append = vi.fn<OutboxWriter['append']>().mockResolvedValue({
      id,
      occurredAt: fact.occurredAt,
    });
    await writeIntakeAttachmentVerification({ append }, scope, fact);
    const data = {
      organizationId,
      actor: { type: 'system', id: 'storage-service' },
      version: 1,
      publicationId: fact.publicationId,
      attachmentId: fact.attachmentId,
    };
    expect(append).toHaveBeenCalledExactlyOnceWith(
      scope,
      eventSchemas,
      INTAKE_ATTACHMENT_VERIFIED_V1,
      data,
    );
    expect(
      eventSchemas[INTAKE_ATTACHMENT_VERIFIED_V1].safeParse({
        ...data,
        id,
        occurredAt: fact.occurredAt,
      }).success,
    ).toBe(true);
  });

  it('rejects a mismatched tenant before appending anything', async () => {
    const scope = {
      kind: 'tenant',
      organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30',
    } as TransactionScope;
    const append = vi.fn<OutboxWriter['append']>();
    await expect(writeIntakeAttachmentVerification({ append }, scope, fact)).rejects.toThrow(
      'the owning tenant transaction',
    );
    expect(append).not.toHaveBeenCalled();
  });
});
