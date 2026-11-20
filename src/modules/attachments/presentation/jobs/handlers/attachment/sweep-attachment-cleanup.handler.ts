import { runWithOrganizationContext } from '@cadenway/nest-common';
import type { Job, JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';

import type { SweepAttachmentCleanup } from '../../../../application/use-cases/commands/attachment/sweep-attachment-cleanup/sweep-attachment-cleanup.use-case.js';

/** Binds tenant work to the organization of an eligible row read from Storage's database. */
function inCleanupOrganization<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
  return runWithOrganizationContext(
    { organizationId, actor: { type: 'system', id: null }, role: null, scopes: [] },
    work,
  );
}

/** Schedules the system sweep and lets pg-boss retry incomplete attempts. */
export class SweepAttachmentCleanupHandler implements OnApplicationBootstrap {
  // #region Properties
  /** Reports counts without object keys, task keys or provider error details. */
  private readonly logger = new Logger(SweepAttachmentCleanupHandler.name);
  // #endregion

  // #region Constructor
  /** Binds the scheduled system entry point to the cleanup sweep. */
  public constructor(
    private readonly workers: JobWorkerRegistry,
    private readonly scheduler: JobScheduler,
    private readonly sweep: Pick<SweepAttachmentCleanup, 'execute'>,
    private readonly queue: string,
  ) {}
  // #endregion

  // #region Methods
  /** Upserts the shared UTC schedule and registers the worker for this replica. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.scheduler.schedule(this.queue, '* * * * *', { key: 'minutely', timeZone: 'UTC' });
    await this.workers.work(this.queue, (job: Job) => this.handle(job));
  }

  /** Runs only system jobs and requests a retry after isolated failures. */
  public async handle(job: Job): Promise<void> {
    if (job.organizationId !== null) throw new Error('Attachment cleanup requires a system job.');
    const counts = await this.sweep.execute({
      cutoff: new Date(),
      signal: job.signal,
      inOrganization: inCleanupOrganization,
    });
    if (counts.failures > 0) {
      this.logger.warn(counts, 'Attachment cleanup sweep incomplete');
      throw new Error('Attachment cleanup sweep failed.');
    }
    if (counts.attachments > 0 || counts.objects > 0) {
      this.logger.log(counts, 'Attachment cleanup sweep completed');
    }
  }
  // #endregion
}
