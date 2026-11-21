import { AttachmentSearchProjectionError } from '../../../../models/search-projection/attachment-search-projection-error.model.js';
import type { AttachmentSearchProjectionCursor } from '../../../../ports/outbound/crypto/search-projection/attachment-search-projection-cursor.port.js';
import type { AttachmentSearchProjectionReader } from '../../../../ports/outbound/persistence/search-projection/attachment-search-projection-reader.port.js';
import type { ListAttachmentSearchProjectionsInput } from './list-attachment-search-projections.input.js';
import type { ListAttachmentSearchProjectionsOutput } from './list-attachment-search-projections.output.js';

/** Exports a bounded page of ready attachment Search metadata. */
export class ListAttachmentSearchProjections {
  // #region Constructor
  /** Binds the tenant reader and stable cursor signer. */
  public constructor(
    private readonly reader: AttachmentSearchProjectionReader,
    private readonly cursor: AttachmentSearchProjectionCursor | null,
  ) {}
  // #endregion

  // #region Methods
  /** Verifies the continuation before reading its snapshot. */
  public async execute(
    input: ListAttachmentSearchProjectionsInput,
  ): Promise<ListAttachmentSearchProjectionsOutput> {
    if (this.cursor === null) throw new AttachmentSearchProjectionError('unavailable');
    const position =
      input.cursor === null ? null : this.cursor.decode(input.organizationId, input.cursor);
    if (input.cursor !== null && position === null) {
      throw new AttachmentSearchProjectionError('invalid-cursor');
    }
    const { items, nextPosition } = await this.reader.list({
      organizationId: input.organizationId,
      position,
      limit: input.limit,
    });
    return {
      items,
      nextCursor:
        nextPosition === null ? null : this.cursor.encode(input.organizationId, nextPosition),
    };
  }
  // #endregion
}
