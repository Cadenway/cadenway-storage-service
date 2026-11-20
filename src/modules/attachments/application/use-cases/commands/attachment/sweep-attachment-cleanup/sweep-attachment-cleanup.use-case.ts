import type { AttachmentCleanupTask } from '../../../../models/attachment/attachment-cleanup-task.model.js';
import type { CleanupCursor } from '../../../../models/attachment/cleanup-cursor.model.js';
import type { AttachmentCleanupDiscovery } from '../../../../ports/outbound/persistence/attachment/attachment-cleanup-discovery.port.js';
import type { CleanAttachmentObjects } from '../clean-attachment-objects/clean-attachment-objects.use-case.js';
import type { CleanPurgedTask } from '../clean-purged-task/clean-purged-task.use-case.js';
import type { SweepAttachmentCleanupInput } from './sweep-attachment-cleanup.input.js';
import type { SweepAttachmentCleanupOutput } from './sweep-attachment-cleanup.output.js';

type SweepCounts = {
  -readonly [Counter in keyof SweepAttachmentCleanupOutput]: SweepAttachmentCleanupOutput[Counter];
};

/** Visits pending work and delegates each batch to its tenant-scoped command. */
export class SweepAttachmentCleanup {
  // #region Constructor
  /** Binds system discovery and the two tenant cleanup commands. */
  public constructor(
    private readonly discovery: AttachmentCleanupDiscovery,
    private readonly purge: Pick<CleanPurgedTask, 'execute'>,
    private readonly erase: Pick<CleanAttachmentObjects, 'execute'>,
  ) {}
  // #endregion

  // #region Methods
  /** Returns counts for successful work and isolated failures that remain eligible. */
  public async execute(input: SweepAttachmentCleanupInput): Promise<SweepAttachmentCleanupOutput> {
    const counts: SweepCounts = { attachments: 0, objects: 0, failures: 0 };
    await this.attempt(input.signal, counts, () => this.sweepPurgedTasks(input, counts));
    await this.attempt(input.signal, counts, () => this.sweepDueObjects(input, counts));
    return counts;
  }

  /** Gives each task one batch per sweep so a large purge does not delay the next task. */
  private async sweepPurgedTasks(
    { signal, inOrganization }: SweepAttachmentCleanupInput,
    counts: SweepCounts,
  ): Promise<void> {
    let after: AttachmentCleanupTask | null = null;
    for (;;) {
      signal.throwIfAborted();
      const tasks = await this.discovery.listPurgedTasks(after);
      if (tasks.length === 0) return;
      for (const task of tasks) {
        after = task;
        await this.attempt(signal, counts, async () => {
          const result = await inOrganization(task.organizationId, () => this.purge.execute(task));
          counts.attachments += result.processed;
        });
      }
    }
  }

  /** Visits each due organization and continues after an isolated tenant failure. */
  private async sweepDueObjects(
    input: SweepAttachmentCleanupInput,
    counts: SweepCounts,
  ): Promise<void> {
    const { cutoff, signal } = input;
    let after: string | null = null;
    for (;;) {
      signal.throwIfAborted();
      const organizations = await this.discovery.listDueObjectOrganizations(cutoff, after);
      if (organizations.length === 0) return;
      for (const organizationId of organizations) {
        after = organizationId;
        await this.attempt(signal, counts, () =>
          this.sweepTenantObjects(organizationId, input, counts),
        );
      }
    }
  }

  /** Uses the same eligibility cutoff and continues after failed erasures in a page. */
  private async sweepTenantObjects(
    organizationId: string,
    { cutoff, signal, inOrganization }: SweepAttachmentCleanupInput,
    counts: SweepCounts,
  ): Promise<void> {
    let after: CleanupCursor | null = null;
    do {
      signal.throwIfAborted();
      const result = await inOrganization(organizationId, () =>
        this.erase.execute({ organizationId, cutoff, after, signal }),
      );
      counts.objects += result.processed;
      counts.failures += result.failed;
      after = result.next;
    } while (after !== null);
  }

  /** Keeps a failed phase or batch retryable and gives the remaining work a turn. */
  private async attempt(
    signal: AbortSignal,
    counts: SweepCounts,
    work: () => Promise<void>,
  ): Promise<void> {
    signal.throwIfAborted();
    try {
      await work();
    } catch {
      signal.throwIfAborted();
      counts.failures += 1;
    }
    signal.throwIfAborted();
  }
  // #endregion
}
