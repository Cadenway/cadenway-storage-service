import type { Job, JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';

import type { CleanProfileMedia } from '../../../../application/use-cases/commands/media/clean-profile-media/clean-profile-media.use-case.js';

const cleanupBatchesPerRun = 8;

/** Runs metadata cleanup and physical inventory on separate leased system schedules. */
export class ProfileMediaMaintenanceHandler implements OnApplicationBootstrap {
  // #region Properties
  /** Reports counts without image bytes, owner identities or object keys. */
  private readonly logger = new Logger(ProfileMediaMaintenanceHandler.name);
  // #endregion

  // #region Constructor
  /** Binds the existing jobs runtime to the scoped cleanup and inventory operations. */
  public constructor(
    private readonly workers: JobWorkerRegistry,
    private readonly scheduler: JobScheduler,
    private readonly cleanup: Pick<CleanProfileMedia, 'execute'>,
    private readonly reconcile: (signal: AbortSignal) => Promise<number>,
    private readonly sweepQueue: string,
    private readonly inventoryQueue: string,
    private readonly enabled: boolean,
  ) {}
  // #endregion

  // #region Methods
  /** Registers one minutely UTC job of each type when Storage owns the bucket. */
  public async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    await this.scheduler.schedule(this.sweepQueue, '* * * * *', {
      key: 'minutely',
      timeZone: 'UTC',
    });
    await this.scheduler.schedule(this.inventoryQueue, '* * * * *', {
      key: 'minutely',
      timeZone: 'UTC',
    });
    await this.workers.work(this.sweepQueue, (job: Job) => this.sweep(job));
    await this.workers.work(this.inventoryQueue, (job: Job) => this.inventory(job));
  }

  /** Advances the persisted owner cursor a bounded number of times, including empty owners. */
  private async sweep(job: Job): Promise<void> {
    if (job.organizationId !== null) throw new Error('Profile cleanup requires a system job.');
    let deleted = 0;
    for (let index = 0; index < cleanupBatchesPerRun; index += 1) {
      job.signal.throwIfAborted();
      deleted += (await this.cleanup.execute({ signal: job.signal })).deleted;
    }
    if (deleted > 0) this.logger.log({ deleted }, 'Profile media cleanup completed');
  }

  /** Advances one independent inventory page and requeues only known eligible late writes. */
  private async inventory(job: Job): Promise<void> {
    if (job.organizationId !== null) throw new Error('Profile inventory requires a system job.');
    job.signal.throwIfAborted();
    const requeued = await this.reconcile(job.signal);
    if (requeued > 0) this.logger.log({ requeued }, 'Profile media objects requeued');
  }
  // #endregion
}
