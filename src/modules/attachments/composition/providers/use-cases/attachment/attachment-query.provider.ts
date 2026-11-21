import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import type { AttachmentObjectStore } from '../../../../application/ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import type { AttachmentReader } from '../../../../application/ports/outbound/persistence/attachment/attachment-reader.port.js';
import type { AttachmentUnitOfWork } from '../../../../application/ports/outbound/transactions/attachment/attachment-unit-of-work.port.js';
import { GetAttachmentDownload } from '../../../../application/use-cases/queries/attachment/get-attachment-download/get-attachment-download.use-case.js';
import { GetAttachment } from '../../../../application/use-cases/queries/attachment/get-attachment/get-attachment.use-case.js';
import { ListAttachments } from '../../../../application/use-cases/queries/attachment/list-attachments/list-attachments.use-case.js';
import { ListLargestAttachments } from '../../../../application/use-cases/queries/attachment/list-largest-attachments/list-largest-attachments.use-case.js';
import { DrizzleAttachmentReader } from '../../../../infrastructure/persistence/drizzle/repositories/attachment/drizzle-attachment-reader.repository.js';
import { ATTACHMENT_OBJECT_STORE } from '../../../tokens/attachment/attachment-object-store.token.js';
import { ATTACHMENT_UNIT_OF_WORK } from '../../../tokens/attachment/attachment-unit-of-work.token.js';

/** Binds tenant-scoped attachment read models to PostgreSQL. */
export const attachmentQueryProviders: readonly FactoryProvider[] = [
  {
    provide: DrizzleAttachmentReader,
    inject: [TenantTransactionRunner],
    useFactory: (runner: TenantTransactionRunner): AttachmentReader =>
      new DrizzleAttachmentReader(runner),
  },
  {
    provide: ListAttachments,
    inject: [DrizzleAttachmentReader],
    useFactory: (reader: AttachmentReader): ListAttachments => new ListAttachments(reader),
  },
  {
    provide: GetAttachment,
    inject: [DrizzleAttachmentReader],
    useFactory: (reader: AttachmentReader): GetAttachment => new GetAttachment(reader),
  },
  {
    provide: ListLargestAttachments,
    inject: [DrizzleAttachmentReader],
    useFactory: (reader: AttachmentReader): ListLargestAttachments =>
      new ListLargestAttachments(reader),
  },
];

/** Binds download signing to the reader and the transactional deletion fence. */
export const getAttachmentDownloadProvider: FactoryProvider<GetAttachmentDownload> = {
  provide: GetAttachmentDownload,
  inject: [DrizzleAttachmentReader, ATTACHMENT_OBJECT_STORE, ATTACHMENT_UNIT_OF_WORK],
  useFactory: (
    reader: AttachmentReader,
    objects: AttachmentObjectStore,
    work: AttachmentUnitOfWork,
  ): GetAttachmentDownload => new GetAttachmentDownload(reader, objects, work),
};
