import { CONFIG } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import type { AttachmentObjectStore } from '../../../../application/ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import type { AttachmentRuntime } from '../../../../application/ports/outbound/runtime/attachment/attachment-runtime.port.js';
import type { AttachmentUnitOfWork } from '../../../../application/ports/outbound/transactions/attachment/attachment-unit-of-work.port.js';
import { ApplyStorageEntitlement } from '../../../../application/use-cases/commands/attachment/apply-storage-entitlement/apply-storage-entitlement.use-case.js';
import { CompleteAttachmentUpload } from '../../../../application/use-cases/commands/attachment/complete-attachment-upload/complete-attachment-upload.use-case.js';
import { DeleteAttachment } from '../../../../application/use-cases/commands/attachment/delete-attachment/delete-attachment.use-case.js';
import { RecordTaskPurge } from '../../../../application/use-cases/commands/attachment/record-task-purge/record-task-purge.use-case.js';
import { StartAttachmentUpload } from '../../../../application/use-cases/commands/attachment/start-attachment-upload/start-attachment-upload.use-case.js';
import { registeredAttachmentMediaType } from '../../../../infrastructure/adapters/media-types/registered-attachment-media-type.adapter.js';
import { PostgresAttachmentRuntime } from '../../../../infrastructure/adapters/runtime/postgres-attachment-runtime.adapter.js';
import { ATTACHMENT_OBJECT_STORE } from '../../../tokens/attachment/attachment-object-store.token.js';
import { ATTACHMENT_UNIT_OF_WORK } from '../../../tokens/attachment/attachment-unit-of-work.token.js';

/** Binds lifecycle commands once their unit of work has the published attachment fact writer. */
export const attachmentCommandProviders: readonly FactoryProvider[] = [
  {
    provide: PostgresAttachmentRuntime,
    inject: [TenantTransactionRunner],
    useFactory: (runner: TenantTransactionRunner): AttachmentRuntime =>
      new PostgresAttachmentRuntime(runner),
  },
  {
    provide: StartAttachmentUpload,
    inject: [ATTACHMENT_UNIT_OF_WORK, ATTACHMENT_OBJECT_STORE, PostgresAttachmentRuntime],
    useFactory: (
      work: AttachmentUnitOfWork,
      objects: AttachmentObjectStore,
      runtime: AttachmentRuntime,
    ): StartAttachmentUpload =>
      new StartAttachmentUpload(work, objects, runtime, registeredAttachmentMediaType),
  },
  {
    provide: CompleteAttachmentUpload,
    inject: [ATTACHMENT_UNIT_OF_WORK, ATTACHMENT_OBJECT_STORE, PostgresAttachmentRuntime, CONFIG],
    useFactory: (
      work: AttachmentUnitOfWork,
      objects: AttachmentObjectStore,
      runtime: AttachmentRuntime,
      config: AppConfig,
    ): CompleteAttachmentUpload =>
      new CompleteAttachmentUpload(work, objects, runtime, config.STORAGE_BYTE_QUOTA_ENABLED),
  },
  {
    provide: ApplyStorageEntitlement,
    inject: [ATTACHMENT_UNIT_OF_WORK],
    useFactory: (work: AttachmentUnitOfWork): ApplyStorageEntitlement =>
      new ApplyStorageEntitlement(work),
  },
  {
    provide: DeleteAttachment,
    inject: [ATTACHMENT_UNIT_OF_WORK, PostgresAttachmentRuntime],
    useFactory: (work: AttachmentUnitOfWork, runtime: AttachmentRuntime): DeleteAttachment =>
      new DeleteAttachment(work, runtime),
  },
  {
    provide: RecordTaskPurge,
    inject: [ATTACHMENT_UNIT_OF_WORK],
    useFactory: (work: AttachmentUnitOfWork): RecordTaskPurge => new RecordTaskPurge(work),
  },
];
