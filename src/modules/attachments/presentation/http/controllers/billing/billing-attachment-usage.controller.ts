import { ListBillingAttachmentUsageInternalResponse } from '@cadenway/contracts/validators/internal/storage-service';
import {
  getOrganizationContext,
  InternalAccess,
  ProblemException,
  requireOrganizationId,
} from '@cadenway/nest-common';
import { Controller, Get, Header, Query } from '@nestjs/common';
import type { z } from 'zod';

import { ListBillingAttachmentUsage } from '../../../../application/use-cases/queries/billing/list-billing-attachment-usage/list-billing-attachment-usage.use-case.js';
import { BillingAttachmentUsagePageDto } from '../../dto/input/billing/billing-attachment-usage-page.dto.js';
import { answerBillingAttachmentUsage } from '../../errors/billing/billing-attachment-usage.problem.js';

/** Exports verified attachment usage only to the signed Billing system actor. */
@Controller('internal/v1/billing-attachment-usage')
@InternalAccess({ issuers: ['billing-service'], actors: ['system'], organization: 'required' })
export class BillingAttachmentUsageController {
  // #region Constructor
  /** Binds the bounded, tenant-scoped export operation. */
  public constructor(private readonly listUsage: ListBillingAttachmentUsage) {}
  // #endregion

  // #region Methods
  /** Returns only the fields of the published usage export. */
  @Get()
  @Header('Cache-Control', 'private, no-store')
  public list(
    @Query() query: BillingAttachmentUsagePageDto,
  ): Promise<z.output<typeof ListBillingAttachmentUsageInternalResponse>> {
    const actor = getOrganizationContext()?.actor;
    if (actor?.type !== 'system' || actor.id !== 'billing-service') {
      throw new ProblemException({ status: 403, code: 'auth.actor-not-allowed' });
    }
    const organizationId = requireOrganizationId();
    return answerBillingAttachmentUsage(async () =>
      ListBillingAttachmentUsageInternalResponse.parse(
        await this.listUsage.execute({
          organizationId,
          cursor: query.cursor ?? null,
          limit: query.limit,
        }),
      ),
    );
  }
  // #endregion
}
