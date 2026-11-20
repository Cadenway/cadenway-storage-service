import type { AttachmentSearchProjectionDecision } from '../../../../models/search-projection/attachment-search-projection-decision.model.js';

/** One decision per file in request order. */
export interface ResolveAttachmentSearchProjectionsOutput {
  // #region Properties
  /** Current decision for each requested ID. */
  readonly results: readonly AttachmentSearchProjectionDecision[];
  // #endregion
}
