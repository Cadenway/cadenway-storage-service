import type { AttachmentSearchProjectionPosition } from '../../../../models/search-projection/attachment-search-projection-position.model.js';

/** Authenticates a continuation and its immutable fence for one organization. */
export interface AttachmentSearchProjectionCursor {
  // #region Methods
  /** Seals a position issued by the attachment reader. */
  encode(organizationId: string, position: AttachmentSearchProjectionPosition): string;

  /** Returns the verified position or null for an invalid continuation. */
  decode(organizationId: string, cursor: string): AttachmentSearchProjectionPosition | null;
  // #endregion
}
