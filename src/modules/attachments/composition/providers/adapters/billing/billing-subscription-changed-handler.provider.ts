import { CONFIG } from '@cadenway/nest-common';
import { EventConsumers } from '@cadenway/nest-messaging';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { ApplyStorageEntitlement } from '../../../../application/use-cases/commands/attachment/apply-storage-entitlement/apply-storage-entitlement.use-case.js';
import { BillingSubscriptionChangedHandler } from '../../../../presentation/messaging/handlers/billing/billing-subscription-changed.handler.js';

/** Registers the Billing snapshot consumer against the Storage-owned projection. */
export const billingSubscriptionChangedHandlerProvider: FactoryProvider<BillingSubscriptionChangedHandler> =
  {
    provide: BillingSubscriptionChangedHandler,
    inject: [EventConsumers, ApplyStorageEntitlement, CONFIG],
    useFactory: (
      consumers: EventConsumers,
      applyEntitlement: ApplyStorageEntitlement,
      { STORAGE_BILLING_ENTITLEMENTS_ENABLED }: Readonly<AppConfig>,
    ): BillingSubscriptionChangedHandler =>
      new BillingSubscriptionChangedHandler(
        consumers,
        applyEntitlement,
        STORAGE_BILLING_ENTITLEMENTS_ENABLED,
      ),
  };
