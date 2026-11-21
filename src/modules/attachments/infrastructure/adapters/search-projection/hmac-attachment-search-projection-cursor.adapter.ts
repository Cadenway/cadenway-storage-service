import type { AttachmentSearchProjectionPosition } from '../../../application/models/search-projection/attachment-search-projection-position.model.js';
import type { AttachmentSearchProjectionCursor } from '../../../application/ports/outbound/crypto/search-projection/attachment-search-projection-cursor.port.js';
import { HmacAttachmentProjectionCursor } from '../projection-cursor/hmac-attachment-projection-cursor.adapter.js';

/** Signs the upper fence and cursor position for a Search export in one tenant. */
export class HmacAttachmentSearchProjectionCursor implements AttachmentSearchProjectionCursor {
  // #region Properties
  /** Cursor codec bound to the Search signing purpose. */
  private readonly codec: HmacAttachmentProjectionCursor;
  // #endregion

  // #region Constructor
  /** Binds the stable 256-bit key for attachment Search exports. */
  public constructor(key: Uint8Array) {
    this.codec = new HmacAttachmentProjectionCursor(key, 'search');
  }
  // #endregion

  // #region Methods
  /** Creates an opaque continuation from the verified tenant and repository position. */
  public encode(organizationId: string, position: AttachmentSearchProjectionPosition): string {
    return this.codec.encode(organizationId, {
      upperId: position.upperFileId,
      afterId: position.afterFileId,
    });
  }

  /** Returns null for malformed, tampered or foreign-tenant continuations. */
  public decode(organizationId: string, cursor: string): AttachmentSearchProjectionPosition | null {
    const position = this.codec.decode(organizationId, cursor);
    return position === null
      ? null
      : { upperFileId: position.upperId, afterFileId: position.afterId };
  }
  // #endregion
}
