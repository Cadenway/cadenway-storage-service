import type { BillingAttachmentUsagePosition } from '../../../../models/billing/billing-attachment-usage-position.model.js';
import type { BillingAttachmentUsageProjection } from '../../../../projections/billing/billing-attachment-usage.projection.js';

/** Reads verified attachment usage states from one organization in ascending UUID order. */
export interface BillingAttachmentUsageReader {
  // #region Methods
  /** Fixes the export bound on the first page or resumes within it on later pages. */
  read(
    organizationId: string,
    position: BillingAttachmentUsagePosition | null,
    maximum: number,
  ): Promise<{
    readonly upperId: string | null;
    readonly items: readonly BillingAttachmentUsageProjection[];
  }>;
  // #endregion
}
