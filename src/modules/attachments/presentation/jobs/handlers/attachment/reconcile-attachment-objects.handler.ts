import type { Job, JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';

import type { ReconcileAttachmentObjects } from '../../../../application/use-cases/commands/attachment/reconcile-attachment-objects/reconcile-attachment-objects.use-case.js';

/** Schedules physical inventory reconciliation for the configured attachment bucket. */
export class ReconcileAttachmentObjectsHandler implements OnApplicationBootstrap {
  // #region Properties
  /** Reports recovery counts without object keys or continuation tokens. */
  private readonly logger = new Logger(ReconcileAttachmentObjectsHandler.name);
  // #endregion

  // #region Constructor
  /** Binds the system job to the inventory command. */
  public constructor(
    private readonly workers: JobWorkerRegistry,
    private readonly scheduler: JobScheduler,
    private readonly reconcile: ReconcileAttachmentObjects,
    private readonly queue: string,
    private readonly enabled: boolean,
  ) {}
  // #endregion

  // #region Methods
  /** Registers the minutely UTC schedule when the service owns an object bucket. */
  public async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    await this.scheduler.schedule(this.queue, '* * * * *', { key: 'minutely', timeZone: 'UTC' });
    await this.workers.work(this.queue, (job: Job) => this.handle(job));
  }

  /** Keeps the durable cursor out of job payloads and logs. */
  public async handle(job: Job): Promise<void> {
    if (job.organizationId !== null)
      throw new Error('Attachment reconciliation requires a system job.');
    const counts = await this.reconcile.execute({ signal: job.signal });
    if (counts.requeued > 0) this.logger.log(counts, 'Attachment objects requeued');
  }
  // #endregion
}
