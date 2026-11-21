import { ListBillingAttachmentUsageInternalQueryParams } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validates a Billing attachment usage export request against the published contract. */
export class BillingAttachmentUsagePageDto extends zodDto(
  ListBillingAttachmentUsageInternalQueryParams.strict(),
) {}
