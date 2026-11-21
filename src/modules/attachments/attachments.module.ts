import { Module } from '@nestjs/common';

import {
  PURGE_UPLOAD_RECEIPTS_QUEUE,
  RECONCILE_ATTACHMENT_OBJECTS_QUEUE,
  SWEEP_ATTACHMENT_CLEANUP_QUEUE,
} from '../../config/job-queues.js';
import { attachmentFactWriterProvider } from './composition/providers/adapters/attachment/attachment-fact-writer.provider.js';
import { attachmentObjectStoreProvider } from './composition/providers/adapters/attachment/attachment-object-store.provider.js';
import { attachmentUnitOfWorkProvider } from './composition/providers/adapters/attachment/attachment-unit-of-work.provider.js';
import { purgeUploadReceiptsHandlerProvider } from './composition/providers/adapters/attachment/purge-upload-receipts-handler.provider.js';
import { reconcileAttachmentObjectsHandlerProvider } from './composition/providers/adapters/attachment/reconcile-attachment-objects-handler.provider.js';
import { sweepAttachmentCleanupHandlerProvider } from './composition/providers/adapters/attachment/sweep-attachment-cleanup-handler.provider.js';
import { taskPurgedHandlerProvider } from './composition/providers/adapters/attachment/task-purged-handler.provider.js';
import { attachmentCommandProviders } from './composition/providers/use-cases/attachment/attachment-command.provider.js';
import {
  attachmentQueryProviders,
  getAttachmentDownloadProvider,
} from './composition/providers/use-cases/attachment/attachment-query.provider.js';
import { purgeExpiredUploadReceiptsProvider } from './composition/providers/use-cases/attachment/purge-expired-upload-receipts.provider.js';
import { AttachmentsController } from './presentation/http/controllers/attachment/attachments.controller.js';

/** Composition boundary for task attachment metadata, signed transfers and cleanup. */
@Module({
  controllers: [AttachmentsController],
  providers: [
    attachmentFactWriterProvider,
    attachmentObjectStoreProvider,
    attachmentUnitOfWorkProvider,
    ...attachmentCommandProviders,
    ...attachmentQueryProviders,
    getAttachmentDownloadProvider,
    purgeExpiredUploadReceiptsProvider,
    purgeUploadReceiptsHandlerProvider(PURGE_UPLOAD_RECEIPTS_QUEUE),
    reconcileAttachmentObjectsHandlerProvider(RECONCILE_ATTACHMENT_OBJECTS_QUEUE),
    sweepAttachmentCleanupHandlerProvider(SWEEP_ATTACHMENT_CLEANUP_QUEUE),
    taskPurgedHandlerProvider,
  ],
})
export class AttachmentsModule {}
