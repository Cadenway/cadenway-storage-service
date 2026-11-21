import {
  eventSchemas,
  INTAKE_ATTACHMENT_CLAIMED_V1,
  INTAKE_ATTACHMENT_RELEASED_V1,
} from '@cadenway/contracts/events/task-service';
import type { IntakeAttachmentClaimedV1 } from '@cadenway/contracts/events/task-service';
import { runWithOrganizationContext } from '@cadenway/nest-common';
import type { EventConsumers, EventContext } from '@cadenway/nest-messaging';
import { describe, expect, it, vi } from 'vitest';

import type { ClaimIntakeAttachment } from '../../../../application/use-cases/commands/intake-attachment/claim-intake-attachment/claim-intake-attachment.use-case.js';
import type { ReleaseIntakeAttachment } from '../../../../application/use-cases/commands/intake-attachment/release-intake-attachment/release-intake-attachment.use-case.js';
import { IntakeAttachmentDecisionsHandler } from './intake-attachment-decisions.handler.js';

const identity = {
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  publicationId: '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f12',
  attachmentId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15',
};
const fact: IntakeAttachmentClaimedV1 = {
  id: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d33',
  occurredAt: '2026-11-20T14:03:00Z',
  ...identity,
  actor: { type: 'system', id: 'task-service' },
  version: 1,
  taskKey: 'CAD-482',
};

async function fixture() {
  const subscribe = vi.fn<EventConsumers['subscribe']>().mockResolvedValue(undefined);
  const claim = vi.fn<ClaimIntakeAttachment['execute']>().mockResolvedValue(undefined);
  const release = vi.fn<ReleaseIntakeAttachment['execute']>().mockResolvedValue(undefined);
  const controller = new AbortController();
  const context: EventContext = {
    deliveryCount: 1,
    streamSequence: 1,
    redelivered: false,
    signal: controller.signal,
    claimVersion: vi.fn<EventContext['claimVersion']>().mockResolvedValue(true),
  };
  await new IntakeAttachmentDecisionsHandler(
    { subscribe },
    { execute: claim },
    { execute: release },
  ).onApplicationBootstrap();
  const [claimSubscription, releaseSubscription] = subscribe.mock.calls.map(([entry]) => entry);
  if (claimSubscription === undefined || releaseSubscription === undefined)
    throw new Error('Missing intake decision subscription.');
  const inTenant = (work: () => Promise<void>, organizationId = identity.organizationId) =>
    runWithOrganizationContext({ organizationId, actor: fact.actor, role: null, scopes: [] }, work);
  return { claimSubscription, releaseSubscription, claim, release, controller, context, inTenant };
}

describe(IntakeAttachmentDecisionsHandler.name, () => {
  it('replays the two exact Task subjects and dispatches normalized identity', async () => {
    const { claimSubscription, releaseSubscription, claim, release, context, inTenant } =
      await fixture();
    expect(claimSubscription).toMatchObject({
      handler: 'claim-intake-attachment',
      schemas: eventSchemas,
      event: INTAKE_ATTACHMENT_CLAIMED_V1,
      deliverPolicy: 'all',
    });
    expect(releaseSubscription).toMatchObject({
      handler: 'release-intake-attachment',
      schemas: eventSchemas,
      event: INTAKE_ATTACHMENT_RELEASED_V1,
      deliverPolicy: 'all',
    });
    const uppercase: IntakeAttachmentClaimedV1 = {
      ...fact,
      publicationId: fact.publicationId.toUpperCase(),
      attachmentId: fact.attachmentId.toUpperCase(),
    };
    await inTenant(() => claimSubscription.handle(uppercase, context));
    const { taskKey, ...released } = fact;
    await inTenant(
      () => releaseSubscription.handle(released, context),
      identity.organizationId.toUpperCase(),
    );
    expect(claim).toHaveBeenCalledExactlyOnceWith({ ...identity, taskKey });
    expect(release).toHaveBeenCalledExactlyOnceWith(identity);
  });

  it('rejects user origins and mismatched delivery tenants before writing', async () => {
    const { claimSubscription, context, claim, inTenant } = await fixture();
    await expect(
      inTenant(() =>
        claimSubscription.handle(
          { ...fact, actor: { type: 'user', id: '019a5f3c-9e1f-7b2a-8c3d-4e5f6a7b8c31' } },
          context,
        ),
      ),
    ).rejects.toThrow('the Task system actor');
    await expect(
      inTenant(
        () => claimSubscription.handle(fact, context),
        '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30',
      ),
    ).rejects.toThrow('the Task system actor');
    expect(claim).not.toHaveBeenCalled();
  });

  it('lets the delivery transaction roll back if abandoned while applying a decision', async () => {
    const { claimSubscription, context, controller, claim, inTenant } = await fixture();
    claim.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(undefined);
    });
    await expect(inTenant(() => claimSubscription.handle(fact, context))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
