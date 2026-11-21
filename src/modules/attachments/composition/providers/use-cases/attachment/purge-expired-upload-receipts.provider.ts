import { SystemTransactionRunner } from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import { PurgeExpiredUploadReceipts } from '../../../../application/use-cases/commands/attachment/purge-expired-upload-receipts/purge-expired-upload-receipts.use-case.js';
import { DrizzleExpiredUploadReceipts } from '../../../../infrastructure/persistence/drizzle/repositories/attachment/drizzle-expired-upload-receipts.repository.js';

/** Binds expiration cleanup to one retryable system transaction per batch. */
export const purgeExpiredUploadReceiptsProvider: FactoryProvider<PurgeExpiredUploadReceipts> = {
  provide: PurgeExpiredUploadReceipts,
  inject: [SystemTransactionRunner],
  useFactory: (system: SystemTransactionRunner): PurgeExpiredUploadReceipts =>
    new PurgeExpiredUploadReceipts(new DrizzleExpiredUploadReceipts(system)),
};
