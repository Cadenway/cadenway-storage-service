import { JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import type { FactoryProvider } from '@nestjs/common';

import { PurgeExpiredUploadReceipts } from '../../../../application/use-cases/commands/attachment/purge-expired-upload-receipts/purge-expired-upload-receipts.use-case.js';
import { PurgeUploadReceiptsHandler } from '../../../../presentation/jobs/handlers/attachment/purge-upload-receipts.handler.js';

/** Registers the cleanup handler with the same queue name provisioned by the service. */
export function purgeUploadReceiptsHandlerProvider(
  queue: string,
): FactoryProvider<PurgeUploadReceiptsHandler> {
  return {
    provide: PurgeUploadReceiptsHandler,
    inject: [JobWorkerRegistry, JobScheduler, PurgeExpiredUploadReceipts],
    useFactory: (
      workers: JobWorkerRegistry,
      scheduler: JobScheduler,
      purge: PurgeExpiredUploadReceipts,
    ): PurgeUploadReceiptsHandler =>
      new PurgeUploadReceiptsHandler(workers, scheduler, purge, queue),
  };
}
