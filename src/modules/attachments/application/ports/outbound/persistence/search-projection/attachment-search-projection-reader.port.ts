import type { AttachmentSearchProjectionDecision } from '../../../../models/search-projection/attachment-search-projection-decision.model.js';
import type { AttachmentSearchProjectionPosition } from '../../../../models/search-projection/attachment-search-projection-position.model.js';
import type { AttachmentSearchProjection } from '../../../../models/search-projection/attachment-search-projection.model.js';

/** Reads current Search projections from tenant snapshots. */
export interface AttachmentSearchProjectionReader {
  // #region Methods
  /** Lists a bounded keyset page and returns the position when more ready files exist. */
  list(input: {
    readonly organizationId: string;
    readonly position: AttachmentSearchProjectionPosition | null;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly AttachmentSearchProjection[];
    readonly nextPosition: AttachmentSearchProjectionPosition | null;
  }>;

  /** Resolves one current decision per file ID in the supplied order. */
  resolve(
    organizationId: string,
    fileIds: readonly string[],
  ): Promise<readonly AttachmentSearchProjectionDecision[]>;
  // #endregion
}
