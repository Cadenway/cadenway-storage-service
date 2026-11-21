import { eventSchemas, SUBSCRIPTION_CHANGED_V1 } from '@cadenway/contracts/events/billing-service';
import type { SubscriptionChangedV1 } from '@cadenway/contracts/events/billing-service';
import { requireOrganizationId } from '@cadenway/nest-common';
import type { EventConsumers, EventContext } from '@cadenway/nest-messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';

import type { ApplyStorageEntitlement } from '../../../../application/use-cases/commands/attachment/apply-storage-entitlement/apply-storage-entitlement.use-case.js';

/** Projects trusted Billing snapshots within the kit's delivery transaction. */
export class BillingSubscriptionChangedHandler implements OnApplicationBootstrap {
  // #region Constructor
  /** Binds Billing delivery to the tenant-scoped byte entitlement projection. */
  public constructor(
    private readonly consumers: Pick<EventConsumers, 'subscribe'>,
    private readonly applyEntitlement: Pick<ApplyStorageEntitlement, 'execute'>,
    private readonly enabled: boolean,
  ) {}
  // #endregion

  // #region Methods
  /** Registers the stable durable after the environment has its Billing broker permissions. */
  public async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    await this.consumers.subscribe({
      handler: 'apply-storage-byte-entitlement',
      schemas: eventSchemas,
      event: SUBSCRIPTION_CHANGED_V1,
      deliverPolicy: 'all',
      handle: (fact, context) => this.apply(fact, context),
    });
  }

  private async apply(fact: SubscriptionChangedV1, context: EventContext): Promise<void> {
    context.signal.throwIfAborted();
    const organizationId = requireOrganizationId().toLowerCase();
    if (
      organizationId !== fact.organizationId.toLowerCase() ||
      fact.actor.type !== 'system' ||
      fact.actor.id !== 'billing-service'
    ) {
      throw new Error(
        'The subscription snapshot requires its tenant and the Billing system actor.',
      );
    }

    const outcome = await this.applyEntitlement.execute({
      organizationId,
      version: fact.version,
      limitBytes: BigInt(fact.storageByteLimit),
    });
    context.signal.throwIfAborted();
    if (outcome === 'conflict' || outcome === 'decrease' || outcome === 'invalid') {
      throw new Error(`Storage byte entitlement projection rejected the snapshot: ${outcome}.`);
    }
  }
  // #endregion
}
