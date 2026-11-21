import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';

import {
  PURGE_UPLOAD_RECEIPTS_QUEUE,
  RECONCILE_ATTACHMENT_OBJECTS_QUEUE,
  SWEEP_ATTACHMENT_CLEANUP_QUEUE,
} from '../../config/job-queues.js';
import { noStoreIntakeAttachments } from '../../infrastructure/http/no-store-intake-attachments.middleware.js';
import { attachmentFactWriterProvider } from './composition/providers/adapters/attachment/attachment-fact-writer.provider.js';
import { attachmentObjectStoreProvider } from './composition/providers/adapters/attachment/attachment-object-store.provider.js';
import { attachmentUnitOfWorkProvider } from './composition/providers/adapters/attachment/attachment-unit-of-work.provider.js';
import { purgeUploadReceiptsHandlerProvider } from './composition/providers/adapters/attachment/purge-upload-receipts-handler.provider.js';
import { reconcileAttachmentObjectsHandlerProvider } from './composition/providers/adapters/attachment/reconcile-attachment-objects-handler.provider.js';
import { sweepAttachmentCleanupHandlerProvider } from './composition/providers/adapters/attachment/sweep-attachment-cleanup-handler.provider.js';
import { taskPurgedHandlerProvider } from './composition/providers/adapters/attachment/task-purged-handler.provider.js';
import { intakeAttachmentDecisionsHandlerProvider } from './composition/providers/adapters/intake-attachment/intake-attachment-decisions-handler.provider.js';
import { intakeAttachmentUnitOfWorkProvider } from './composition/providers/adapters/intake-attachment/intake-attachment-unit-of-work.provider.js';
import { attachmentCommandProviders } from './composition/providers/use-cases/attachment/attachment-command.provider.js';
import {
  attachmentQueryProviders,
  getAttachmentDownloadProvider,
} from './composition/providers/use-cases/attachment/attachment-query.provider.js';
import { purgeExpiredUploadReceiptsProvider } from './composition/providers/use-cases/attachment/purge-expired-upload-receipts.provider.js';
import { listBillingAttachmentUsageProvider } from './composition/providers/use-cases/billing/list-billing-attachment-usage.provider.js';
import { intakeAttachmentCommandProviders } from './composition/providers/use-cases/intake-attachment/intake-attachment-command.provider.js';
import { attachmentSearchProjectionProviders } from './composition/providers/use-cases/search-projection/attachment-search-projection.provider.js';
import { AttachmentsController } from './presentation/http/controllers/attachment/attachments.controller.js';
import { BillingAttachmentUsageController } from './presentation/http/controllers/billing/billing-attachment-usage.controller.js';
import { IntakeAttachmentsController } from './presentation/http/controllers/intake-attachment/intake-attachments.controller.js';
import { AttachmentSearchProjectionsController } from './presentation/http/controllers/search-projection/attachment-search-projections.controller.js';

/** Composition boundary for task attachment metadata, signed transfers and cleanup. */
@Module({
  controllers: [
    AttachmentsController,
    IntakeAttachmentsController,
    AttachmentSearchProjectionsController,
    BillingAttachmentUsageController,
  ],
  providers: [
    attachmentFactWriterProvider,
    attachmentObjectStoreProvider,
    attachmentUnitOfWorkProvider,
    intakeAttachmentUnitOfWorkProvider,
    ...attachmentCommandProviders,
    ...intakeAttachmentCommandProviders,
    ...attachmentQueryProviders,
    ...attachmentSearchProjectionProviders,
    listBillingAttachmentUsageProvider,
    getAttachmentDownloadProvider,
    purgeExpiredUploadReceiptsProvider,
    purgeUploadReceiptsHandlerProvider(PURGE_UPLOAD_RECEIPTS_QUEUE),
    reconcileAttachmentObjectsHandlerProvider(RECONCILE_ATTACHMENT_OBJECTS_QUEUE),
    sweepAttachmentCleanupHandlerProvider(SWEEP_ATTACHMENT_CLEANUP_QUEUE),
    taskPurgedHandlerProvider,
    intakeAttachmentDecisionsHandlerProvider,
  ],
})
export class AttachmentsModule implements NestModule {
  // #region Methods
  /** Marks private intake responses before the controller's authentication and validation. */
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(noStoreIntakeAttachments).forRoutes(IntakeAttachmentsController);
  }
  // #endregion
}
