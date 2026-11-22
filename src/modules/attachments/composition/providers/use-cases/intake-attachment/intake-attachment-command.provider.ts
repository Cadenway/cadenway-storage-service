import { CONFIG } from '@cadenway/nest-common';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import type { IntakeAttachmentObjectStore } from '../../../../application/ports/outbound/object-storage/intake-attachment/intake-attachment-object-store.port.js';
import type { AttachmentRuntime } from '../../../../application/ports/outbound/runtime/attachment/attachment-runtime.port.js';
import type { IntakeAttachmentUnitOfWork } from '../../../../application/ports/outbound/transactions/intake-attachment/intake-attachment-unit-of-work.port.js';
import { ClaimIntakeAttachment } from '../../../../application/use-cases/commands/intake-attachment/claim-intake-attachment/claim-intake-attachment.use-case.js';
import { CompleteIntakeAttachmentUpload } from '../../../../application/use-cases/commands/intake-attachment/complete-intake-attachment-upload/complete-intake-attachment-upload.use-case.js';
import { ReleaseIntakeAttachment } from '../../../../application/use-cases/commands/intake-attachment/release-intake-attachment/release-intake-attachment.use-case.js';
import { StartIntakeAttachmentUpload } from '../../../../application/use-cases/commands/intake-attachment/start-intake-attachment-upload/start-intake-attachment-upload.use-case.js';
import { registeredAttachmentMediaType } from '../../../../infrastructure/adapters/media-types/registered-attachment-media-type.adapter.js';
import { PostgresAttachmentRuntime } from '../../../../infrastructure/adapters/runtime/postgres-attachment-runtime.adapter.js';
import { ATTACHMENT_OBJECT_STORE } from '../../../tokens/attachment/attachment-object-store.token.js';
import { INTAKE_ATTACHMENT_UNIT_OF_WORK } from '../../../tokens/intake-attachment/intake-attachment-unit-of-work.token.js';

/** Binds the anonymous reservation and Task decision commands to Storage-owned adapters. */
export const intakeAttachmentCommandProviders: readonly FactoryProvider[] = [
  {
    provide: StartIntakeAttachmentUpload,
    inject: [INTAKE_ATTACHMENT_UNIT_OF_WORK, ATTACHMENT_OBJECT_STORE, PostgresAttachmentRuntime],
    useFactory: (
      work: IntakeAttachmentUnitOfWork,
      objects: IntakeAttachmentObjectStore,
      runtime: AttachmentRuntime,
    ): StartIntakeAttachmentUpload =>
      new StartIntakeAttachmentUpload(work, objects, runtime, registeredAttachmentMediaType),
  },
  {
    provide: CompleteIntakeAttachmentUpload,
    inject: [
      INTAKE_ATTACHMENT_UNIT_OF_WORK,
      ATTACHMENT_OBJECT_STORE,
      PostgresAttachmentRuntime,
      CONFIG,
    ],
    useFactory: (
      work: IntakeAttachmentUnitOfWork,
      objects: IntakeAttachmentObjectStore,
      runtime: AttachmentRuntime,
      config: AppConfig,
    ): CompleteIntakeAttachmentUpload =>
      new CompleteIntakeAttachmentUpload(work, objects, runtime, config.STORAGE_BYTE_QUOTA_ENABLED),
  },
  {
    provide: ClaimIntakeAttachment,
    inject: [INTAKE_ATTACHMENT_UNIT_OF_WORK, PostgresAttachmentRuntime],
    useFactory: (
      work: IntakeAttachmentUnitOfWork,
      runtime: AttachmentRuntime,
    ): ClaimIntakeAttachment => new ClaimIntakeAttachment(work, runtime),
  },
  {
    provide: ReleaseIntakeAttachment,
    inject: [INTAKE_ATTACHMENT_UNIT_OF_WORK, PostgresAttachmentRuntime],
    useFactory: (
      work: IntakeAttachmentUnitOfWork,
      runtime: AttachmentRuntime,
    ): ReleaseIntakeAttachment => new ReleaseIntakeAttachment(work, runtime),
  },
];
