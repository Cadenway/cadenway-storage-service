import { AttachmentRefusal } from '../../../../models/attachment/attachment-refusal.model.js';
import type { AttachmentReader } from '../../../../ports/outbound/persistence/attachment/attachment-reader.port.js';
import type { GetAttachmentInput } from './get-attachment.input.js';
import type { GetAttachmentOutput } from './get-attachment.output.js';

/** Reads ready metadata only for a verified organization and task. */
export class GetAttachment {
  // #region Constructor
  /** Binds the tenant-scoped reader. */
  public constructor(private readonly reader: AttachmentReader) {}
  // #endregion

  // #region Methods
  /** Hides pending, deleted and unrelated attachments. */
  public async execute(input: GetAttachmentInput): Promise<GetAttachmentOutput> {
    const found = await this.reader.findReady(
      input.organizationId,
      input.taskKey,
      input.attachmentId,
    );
    if (found === null) throw new AttachmentRefusal('not-found');
    return found.attachment;
  }
  // #endregion
}
