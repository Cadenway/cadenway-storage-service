import type { AttachmentReader } from '../../../../ports/outbound/persistence/attachment/attachment-reader.port.js';
import type { ListAttachmentsInput } from './list-attachments.input.js';
import type { ListAttachmentsOutput } from './list-attachments.output.js';

/** Lists ready attachments after the gateway checks task access. */
export class ListAttachments {
  // #region Constructor
  /** Binds the scoped reader. */
  public constructor(private readonly reader: AttachmentReader) {}
  // #endregion

  // #region Methods
  /** Returns a task-scoped keyset page. */
  public execute(input: ListAttachmentsInput): Promise<ListAttachmentsOutput> {
    return this.reader.listTask(input);
  }
  // #endregion
}
