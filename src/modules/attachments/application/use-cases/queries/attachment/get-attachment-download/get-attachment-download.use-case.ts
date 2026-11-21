import { AttachmentRefusal } from '../../../../models/attachment/attachment-refusal.model.js';
import type { AttachmentObjectStore } from '../../../../ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import type { AttachmentReader } from '../../../../ports/outbound/persistence/attachment/attachment-reader.port.js';
import type { AttachmentUnitOfWork } from '../../../../ports/outbound/transactions/attachment/attachment-unit-of-work.port.js';
import type { GetAttachmentDownloadInput } from './get-attachment-download.input.js';
import type { GetAttachmentDownloadOutput } from './get-attachment-download.output.js';

/** Signs downloads only for ready attachments of the verified tenant and task. */
export class GetAttachmentDownload {
  // #region Constructor
  /** Binds the metadata reader, signer and tenant transaction. */
  public constructor(
    private readonly reader: AttachmentReader,
    private readonly objects: AttachmentObjectStore,
    private readonly work: AttachmentUnitOfWork,
  ) {}
  // #endregion

  // #region Methods
  /** Signs the accepted object with an attachment content disposition. */
  public async execute(input: GetAttachmentDownloadInput): Promise<GetAttachmentDownloadOutput> {
    const found = await this.reader.findReady(
      input.organizationId,
      input.taskKey,
      input.attachmentId,
    );
    if (found === null) throw new AttachmentRefusal('not-found');
    const signed = await this.objects.signDownload({
      objectKey: found.objectKey,
      fileName: found.attachment.fileName,
    });
    await this.work.run(input.organizationId, async (store) => {
      if (await store.lockTask(input.taskKey)) throw new AttachmentRefusal('not-found');
      const attachment = await store.lockAttachment(
        input.taskKey,
        input.attachmentId,
        found.objectKey,
      );
      if (attachment?.snapshot.status !== 'ready') throw new AttachmentRefusal('not-found');
    });
    return signed;
  }
  // #endregion
}
