import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  listBillingAttachmentUsageInternalResponseItemsItemOneFileIdRegExp,
  resolveAttachmentSearchProjectionsInternalBodyFileIdsItemRegExp,
} from '@cadenway/contracts/validators/internal/storage-service';

// Two 36-byte UUIDs and their separator encode to 98 base64url characters. SHA-256 encodes to 43.
const token = /^v1\.([a-zA-Z0-9_-]{98})\.([a-zA-Z0-9_-]{43})$/u;

const scopes = {
  search: {
    label: 'Search',
    signingDomain: 'storage:attachment-search-projections:v1\0',
    fileId: resolveAttachmentSearchProjectionsInternalBodyFileIdsItemRegExp,
  },
  billing: {
    label: 'Billing',
    signingDomain: 'storage:billing-attachment-usage:v1\0',
    fileId: listBillingAttachmentUsageInternalResponseItemsItemOneFileIdRegExp,
  },
} as const;

interface Position {
  // #region Properties
  /** Inclusive upper attachment ID fixed at the start of the export. */
  readonly upperId: string;

  /** Exclusive lower attachment ID for the next page. */
  readonly afterId: string;
  // #endregion
}

/** Authenticates an attachment export position for one organization and operation. */
export class HmacAttachmentProjectionCursor {
  // #region Properties
  /** Independent copy of the configured signing key. */
  private readonly key: Buffer;
  // #endregion

  // #region Constructor
  /** Binds a cursor purpose and its stable 256-bit key. */
  public constructor(
    key: Uint8Array,
    private readonly purpose: keyof typeof scopes,
  ) {
    if (key.byteLength !== 32) {
      throw new Error(`The attachment ${scopes[purpose].label} cursor key must be 32 bytes.`);
    }
    this.key = Buffer.from(key);
  }
  // #endregion

  // #region Methods
  /** Creates an opaque continuation from the verified tenant and export position. */
  public encode(organizationId: string, position: Position): string {
    const upper = position.upperId.toLowerCase();
    const after = position.afterId.toLowerCase();
    const { fileId, label } = scopes[this.purpose];
    if (!fileId.test(upper) || !fileId.test(after) || after >= upper) {
      throw new Error(`Attachment ${label} cursor position is invalid.`);
    }
    const payload = Buffer.from(`${upper}:${after}`, 'utf8').toString('base64url');
    return `v1.${payload}.${this.sign(organizationId, payload).toString('base64url')}`;
  }

  /** Returns null for malformed continuations or continuations belonging to another scope. */
  public decode(organizationId: string, cursor: string): Position | null {
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
    const [upperId, afterId, unexpected] = Buffer.from(payload, 'base64url')
      .toString('utf8')
      .split(':');
    const { fileId } = scopes[this.purpose];
    if (
      upperId === undefined ||
      afterId === undefined ||
      unexpected !== undefined ||
      !fileId.test(upperId) ||
      !fileId.test(afterId) ||
      afterId >= upperId
    ) {
      return null;
    }
    return { upperId, afterId };
  }

  private sign(organizationId: string, payload: string): Buffer {
    return createHmac('sha256', this.key)
      .update(scopes[this.purpose].signingDomain)
      .update(organizationId.toLowerCase())
      .update('\0')
      .update(payload)
      .digest();
  }
  // #endregion
}
