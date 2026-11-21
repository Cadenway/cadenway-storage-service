import type { Job, JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';

import type { PurgeExpiredUploadReceipts } from '../../../../application/use-cases/commands/attachment/purge-expired-upload-receipts/purge-expired-upload-receipts.use-case.js';

/** Registers the durable system job that removes expired upload receipts. */
export class PurgeUploadReceiptsHandler implements OnApplicationBootstrap {
  // #region Properties
  /** Logs job counts without reading receipt data. */
  private readonly logger = new Logger(PurgeUploadReceiptsHandler.name);
  // #endregion

  // #region Constructor
  /** Binds the worker and scheduler to the provisioned queue. */
  public constructor(
    private readonly workers: JobWorkerRegistry,
    private readonly scheduler: JobScheduler,
    private readonly purge: PurgeExpiredUploadReceipts,
    private readonly queue: string,
  ) {}
  // #endregion

  // #region Methods
  /** Upserts the same UTC schedule in every replica and registers its local worker. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.scheduler.schedule(this.queue, '* * * * *', { key: 'minutely', timeZone: 'UTC' });
    await this.workers.work(this.queue, (job: Job) => this.handle(job));
  }

  /** Runs retention across organizations only when the job has no tenant. */
  public async handle(job: Job): Promise<void> {
    if (job.organizationId !== null) {
      throw new Error('Upload receipt cleanup requires a system job.');
    }
    const purged = await this.purge.execute(job.signal);
    if (purged > 0) this.logger.log({ jobId: job.id, purged }, 'Expired upload receipts removed');
  }
  // #endregion
}
