import { CONFIG } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { ListBillingAttachmentUsage } from '../../../../application/use-cases/queries/billing/list-billing-attachment-usage/list-billing-attachment-usage.use-case.js';
import { HmacAttachmentProjectionCursor } from '../../../../infrastructure/adapters/projection-cursor/hmac-attachment-projection-cursor.adapter.js';
import { DrizzleBillingAttachmentUsageReader } from '../../../../infrastructure/persistence/drizzle/repositories/billing/drizzle-billing-attachment-usage.repository.js';

/** Binds the Billing export to the owned attachment reader and stable cursor key. */
export const listBillingAttachmentUsageProvider: FactoryProvider<ListBillingAttachmentUsage> = {
  provide: ListBillingAttachmentUsage,
  inject: [TenantTransactionRunner, CONFIG],
  useFactory: (tenant: TenantTransactionRunner, config: AppConfig): ListBillingAttachmentUsage => {
    const key = config.BILLING_PROJECTION_CURSOR_SECRET;
    const cursor =
      key === undefined
        ? null
        : new HmacAttachmentProjectionCursor(Buffer.from(key, 'base64url'), 'billing');
    return new ListBillingAttachmentUsage(new DrizzleBillingAttachmentUsageReader(tenant), cursor);
  },
};
