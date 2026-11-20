import { CONFIG } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import type { IntakeAttachmentUnitOfWork } from '../../../../application/ports/outbound/transactions/intake-attachment/intake-attachment-unit-of-work.port.js';
import { UploadReceiptCodec } from '../../../../infrastructure/adapters/crypto/upload-receipt.codec.js';
import type { createAttachmentFactWriter } from '../../../../infrastructure/messaging/outbox/attachment/outbox-attachment-facts.adapter.js';
import { writeIntakeAttachmentVerification } from '../../../../infrastructure/messaging/outbox/intake-attachment/outbox-intake-attachment-verification.adapter.js';
import { DrizzleIntakeAttachmentUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/attachment/drizzle-intake-attachment.unit-of-work.js';
import { ATTACHMENT_FACT_WRITER } from '../../../tokens/attachment/attachment-fact-writer.token.js';
import { INTAKE_ATTACHMENT_UNIT_OF_WORK } from '../../../tokens/intake-attachment/intake-attachment-unit-of-work.token.js';

/** Binds tenant state and the verification and file facts to their shared transaction. */
export const intakeAttachmentUnitOfWorkProvider: FactoryProvider<IntakeAttachmentUnitOfWork> = {
  provide: INTAKE_ATTACHMENT_UNIT_OF_WORK,
  inject: [TenantTransactionRunner, OutboxWriter, ATTACHMENT_FACT_WRITER, CONFIG],
  useFactory: (
    runner: TenantTransactionRunner,
    outbox: OutboxWriter,
    writeFile: ReturnType<typeof createAttachmentFactWriter>,
    { objectStorage }: Readonly<AppConfig>,
  ): IntakeAttachmentUnitOfWork =>
    new DrizzleIntakeAttachmentUnitOfWork(
      runner,
      (scope, fact) => writeIntakeAttachmentVerification(outbox, scope, fact),
      (scope, fact) => writeFile(scope, fact, { type: 'system', id: 'storage-service' }),
      objectStorage === undefined ? undefined : new UploadReceiptCodec(objectStorage.receiptKeys),
    ),
};
