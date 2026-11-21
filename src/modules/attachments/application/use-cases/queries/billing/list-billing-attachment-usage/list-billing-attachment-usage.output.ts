import type { BillingAttachmentUsageProjection } from '../../../../projections/billing/billing-attachment-usage.projection.js';

/** Bounded attachment usage states and an optional authenticated continuation. */
export interface ListBillingAttachmentUsageOutput {
  // #region Properties
  /** Ready attachments and retained terminal deletions. */
  readonly items: readonly BillingAttachmentUsageProjection[];

  /** Continuation for the next page, or null after the last page. */
  readonly nextCursor: string | null;
  // #endregion
}
