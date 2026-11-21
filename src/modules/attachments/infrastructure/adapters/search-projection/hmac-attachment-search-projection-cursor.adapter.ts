import { createHmac, timingSafeEqual } from 'node:crypto';

import { resolveAttachmentSearchProjectionsInternalBodyFileIdsItemRegExp as fileId } from '@cadenway/contracts/validators/internal/storage-service';

import type { AttachmentSearchProjectionPosition } from '../../../application/models/search-projection/attachment-search-projection-position.model.js';
import type { AttachmentSearchProjectionCursor } from '../../../application/ports/outbound/crypto/search-projection/attachment-search-projection-cursor.port.js';

// Two 36-byte UUIDs and their separator encode to 98 base64url characters. SHA-256 encodes to 43.
const token = /^v1\.([a-zA-Z0-9_-]{98})\.([a-zA-Z0-9_-]{43})$/u;

/** Signs the upper fence and cursor position for a Search export in one tenant. */
export class HmacAttachmentSearchProjectionCursor implements AttachmentSearchProjectionCursor {
  // #region Properties
  /** Independent copy of the configured signing key. */
  private readonly key: Buffer;
  // #endregion

  // #region Constructor
  /** Binds the stable 256-bit key for attachment Search exports. */
  public constructor(key: Uint8Array) {
    if (key.byteLength !== 32)
      throw new Error('The attachment Search cursor key must be 32 bytes.');
    this.key = Buffer.from(key);
  }
  // #endregion

  // #region Methods
  /** Creates an opaque continuation from the verified tenant and repository position. */
  public encode(organizationId: string, position: AttachmentSearchProjectionPosition): string {
    const upper = position.upperFileId.toLowerCase();
    const after = position.afterFileId.toLowerCase();
    if (!fileId.test(upper) || !fileId.test(after) || after >= upper) {
      throw new Error('Attachment Search cursor position is invalid.');
    }
    const payload = Buffer.from(`${upper}:${after}`, 'utf8').toString('base64url');
    return `v1.${payload}.${this.sign(organizationId, payload).toString('base64url')}`;
  }

  /** Returns null for malformed, tampered or foreign-tenant continuations. */
  public decode(organizationId: string, cursor: string): AttachmentSearchProjectionPosition | null {
    const [, payload, encodedSignature] = token.exec(cursor) ?? [];
    if (payload === undefined || encodedSignature === undefined) {
      return null;
    }
    const signature = Buffer.from(encodedSignature, 'base64url');
    if (
      signature.toString('base64url') !== encodedSignature ||
      !timingSafeEqual(signature, this.sign(organizationId, payload))
    ) {
      return null;
    }
    const [upperFileId, afterFileId, unexpected] = Buffer.from(payload, 'base64url')
      .toString('utf8')
      .split(':');
    if (
      upperFileId === undefined ||
      afterFileId === undefined ||
      unexpected !== undefined ||
      !fileId.test(upperFileId) ||
      !fileId.test(afterFileId) ||
      afterFileId >= upperFileId
    ) {
      return null;
    }
    return { upperFileId, afterFileId };
  }

  private sign(organizationId: string, payload: string): Buffer {
    return createHmac('sha256', this.key)
      .update('storage:attachment-search-projections:v1\0')
      .update(organizationId.toLowerCase())
      .update('\0')
      .update(payload)
      .digest();
  }
  // #endregion
}
