import type { AttachmentReader } from '../../../../ports/outbound/persistence/attachment/attachment-reader.port.js';
import type { ListLargestAttachmentsInput } from './list-largest-attachments.input.js';
import type { ListLargestAttachmentsOutput } from './list-largest-attachments.output.js';

/** Lists organization usage after the gateway authorizes an administrator. */
export class ListLargestAttachments {
  // #region Constructor
  /** Binds the scoped reader. */
  public constructor(private readonly reader: AttachmentReader) {}
  // #endregion

  // #region Methods
  /** Returns the tenant-scoped keyset page. */
  public execute(input: ListLargestAttachmentsInput): Promise<ListLargestAttachmentsOutput> {
    return this.reader.listLargest(input);
  }
  // #endregion
}
