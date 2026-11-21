import type { BillingAttachmentUsagePosition } from '../../../../models/billing/billing-attachment-usage-position.model.js';

/** Authenticates a Billing export continuation for one organization and operation. */
export interface BillingAttachmentUsageCursor {
  // #region Methods
  /** Seals the fixed upper ID and the last returned attachment ID. */
  encode(organizationId: string, position: BillingAttachmentUsagePosition): string;

  /** Returns the verified position or null if the continuation cannot be authenticated. */
  decode(organizationId: string, cursor: string): BillingAttachmentUsagePosition | null;
  // #endregion
}
