import { eventSchemas, SUBSCRIPTION_CHANGED_V1 } from '@cadenway/contracts/events/billing-service';
import type { SubscriptionChangedV1 } from '@cadenway/contracts/events/billing-service';
import { runWithOrganizationContext } from '@cadenway/nest-common';
import type { EventConsumers, EventContext } from '@cadenway/nest-messaging';
import { describe, expect, it, vi } from 'vitest';

import type { ApplyStorageEntitlement } from '../../../../application/use-cases/commands/attachment/apply-storage-entitlement/apply-storage-entitlement.use-case.js';
import { BillingSubscriptionChangedHandler } from './billing-subscription-changed.handler.js';

const fact: SubscriptionChangedV1 = {
  id: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d42',
  occurredAt: '2026-11-21T14:08:00Z',
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  actor: { type: 'system', id: 'billing-service' },
  version: 4,
  plan: 'team',
  seatLimit: 18,
  storageByteLimit: 100_000_000_000,
};

async function fixture() {
  const subscribe = vi.fn<EventConsumers['subscribe']>().mockResolvedValue(undefined);
  const execute = vi.fn<ApplyStorageEntitlement['execute']>().mockResolvedValue('applied');
  const controller = new AbortController();
  const context: EventContext = {
    deliveryCount: 1,
    streamSequence: 1,
    redelivered: false,
    signal: controller.signal,
    claimVersion: vi.fn<EventContext['claimVersion']>().mockResolvedValue(true),
  };
  await new BillingSubscriptionChangedHandler(
    { subscribe },
    { execute },
    true,
  ).onApplicationBootstrap();
  const subscription = subscribe.mock.calls[0]?.[0];
  if (subscription === undefined) throw new Error('Missing Billing snapshot subscription.');
  const inTenant = (work: () => Promise<void>, organizationId = fact.organizationId) =>
    runWithOrganizationContext({ organizationId, actor: fact.actor, role: null, scopes: [] }, work);
  return { subscription, execute, context, controller, inTenant };
}

describe(BillingSubscriptionChangedHandler.name, () => {
  it('leaves the durable unregistered until snapshot consumption is enabled', async () => {
    const subscribe = vi.fn<EventConsumers['subscribe']>();
    const execute = vi.fn<ApplyStorageEntitlement['execute']>();
    await new BillingSubscriptionChangedHandler(
      { subscribe },
      { execute },
      false,
    ).onApplicationBootstrap();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('replays the official Billing event and delegates its normalized decimal bytes', async () => {
    const { subscription, execute, context, inTenant } = await fixture();
    expect(subscription).toMatchObject({
      handler: 'apply-storage-byte-entitlement',
      schemas: eventSchemas,
      event: SUBSCRIPTION_CHANGED_V1,
      deliverPolicy: 'all',
    });
    await inTenant(() =>
      subscription.handle({ ...fact, organizationId: fact.organizationId.toUpperCase() }, context),
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      organizationId: fact.organizationId,
      version: fact.version,
      limitBytes: 100_000_000_000n,
    });
    expect(context.claimVersion).not.toHaveBeenCalled();
  });

  it('refuses a different system actor and a mismatched delivery tenant before applying', async () => {
    const { subscription, execute, context, inTenant } = await fixture();
    await expect(
      inTenant(() =>
        subscription.handle({ ...fact, actor: { type: 'system', id: 'storage-service' } }, context),
      ),
    ).rejects.toThrow('requires its tenant and the Billing system actor');
    await expect(
      inTenant(() => subscription.handle(fact, context), '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30'),
    ).rejects.toThrow('requires its tenant and the Billing system actor');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['unchanged', 'stale'] as const)(
    'acknowledges a snapshot that is %s',
    async (outcome) => {
      const { subscription, execute, context, inTenant } = await fixture();
      execute.mockResolvedValueOnce(outcome);
      await expect(inTenant(() => subscription.handle(fact, context))).resolves.toBeUndefined();
    },
  );

  it.each(['conflict', 'decrease', 'invalid'] as const)(
    'rejects a %s for the durable retry policy',
    async (outcome) => {
      const { subscription, execute, context, inTenant } = await fixture();
      execute.mockResolvedValueOnce(outcome);
      await expect(inTenant(() => subscription.handle(fact, context))).rejects.toThrow(outcome);
    },
  );

  it('rejects delivery if its deadline expires while applying the snapshot', async () => {
    const { subscription, execute, context, controller, inTenant } = await fixture();
    execute.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve('applied');
    });
    await expect(inTenant(() => subscription.handle(fact, context))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
