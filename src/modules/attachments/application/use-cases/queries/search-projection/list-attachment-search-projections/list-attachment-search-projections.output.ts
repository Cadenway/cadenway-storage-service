import type { AttachmentSearchProjection } from '../../../../models/search-projection/attachment-search-projection.model.js';

/** A page of ready Search metadata and its opaque continuation. */
export interface ListAttachmentSearchProjectionsOutput {
  // #region Properties
  /** Ready projections in ascending file-ID order. */
  readonly items: readonly AttachmentSearchProjection[];

  /** Signed continuation, or null on the final page. */
  readonly nextCursor: string | null;
  // #endregion
}
