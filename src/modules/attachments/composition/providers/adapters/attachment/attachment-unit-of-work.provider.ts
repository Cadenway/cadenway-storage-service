import { CONFIG } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { TransactionScope } from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import type { AttachmentTransaction } from '../../../../application/models/attachment/attachment-transaction.model.js';
import type { AttachmentUnitOfWork } from '../../../../application/ports/outbound/transactions/attachment/attachment-unit-of-work.port.js';
import { UploadReceiptCodec } from '../../../../infrastructure/adapters/crypto/upload-receipt.codec.js';
import { DrizzleAttachmentTransaction } from '../../../../infrastructure/persistence/drizzle/repositories/attachment/drizzle-attachment-transaction.repository.js';
import { ATTACHMENT_FACT_WRITER } from '../../../tokens/attachment/attachment-fact-writer.token.js';
import { ATTACHMENT_UNIT_OF_WORK } from '../../../tokens/attachment/attachment-unit-of-work.token.js';

type FactWriter = (
  scope: TransactionScope,
  ...fact: Parameters<AttachmentTransaction['appendFact']>
) => Promise<void>;

/** Joins the verified tenant transaction and binds the fact writer to that same scope. */
export const attachmentUnitOfWorkProvider: FactoryProvider<AttachmentUnitOfWork> = {
  provide: ATTACHMENT_UNIT_OF_WORK,
  inject: [TenantTransactionRunner, ATTACHMENT_FACT_WRITER, CONFIG],
  useFactory: (
    runner: TenantTransactionRunner,
    writeFact: FactWriter,
    { objectStorage }: Readonly<AppConfig>,
  ): AttachmentUnitOfWork => {
    const receipts =
      objectStorage === undefined ? undefined : new UploadReceiptCodec(objectStorage.receiptKeys);
    return {
      run<T>(
        organizationId: string,
        work: (store: AttachmentTransaction) => Promise<T>,
      ): Promise<T> {
        return runner.run((scope) =>
          work(
            new DrizzleAttachmentTransaction(
              scope,
              organizationId,
              (fact, actor) => writeFact(scope, fact, actor),
              receipts,
            ),
          ),
        );
      },
    };
  },
};
