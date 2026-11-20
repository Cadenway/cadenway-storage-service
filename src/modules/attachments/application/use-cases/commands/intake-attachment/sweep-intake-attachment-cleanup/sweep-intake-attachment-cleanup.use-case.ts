import type { CleanupCursor } from '../../../../models/attachment/cleanup-cursor.model.js';
import type { IntakeAttachmentCleanupDiscovery } from '../../../../ports/outbound/persistence/intake-attachment/intake-attachment-cleanup-discovery.port.js';
import type { SweepAttachmentCleanupInput } from '../../attachment/sweep-attachment-cleanup/sweep-attachment-cleanup.input.js';
import type { SweepAttachmentCleanupOutput } from '../../attachment/sweep-attachment-cleanup/sweep-attachment-cleanup.output.js';
import type { CleanIntakeAttachmentObjects } from '../clean-intake-attachment-objects/clean-intake-attachment-objects.use-case.js';

/** Visits due anonymous upload cleanup in bounded tenant-scoped pages. */
export class SweepIntakeAttachmentCleanup {
  // #region Constructor
  /** Binds system discovery and the tenant object cleanup command. */
  public constructor(
    private readonly discovery: IntakeAttachmentCleanupDiscovery,
    private readonly erase: Pick<CleanIntakeAttachmentObjects, 'execute'>,
  ) {}
  // #endregion

  // #region Methods
  /** Returns aggregate counts while keeping failed tenants eligible for a later sweep. */
  public async execute(input: SweepAttachmentCleanupInput): Promise<SweepAttachmentCleanupOutput> {
    let objects = 0;
    let failures = 0;
    let after: string | null = null;
    for (;;) {
      input.signal.throwIfAborted();
      const organizations = await this.discovery.listDueObjectOrganizations(input.cutoff, after);
      if (organizations.length === 0) return { attachments: 0, objects, failures };
      for (const organizationId of organizations) {
        after = organizationId;
        try {
          let cursor: CleanupCursor | null = null;
          do {
            input.signal.throwIfAborted();
            const result = await input.inOrganization(organizationId, () =>
              this.erase.execute({
                organizationId,
                cutoff: input.cutoff,
                after: cursor,
                signal: input.signal,
              }),
            );
            objects += result.processed;
            failures += result.failed;
            cursor = result.next;
          } while (cursor !== null);
        } catch {
          input.signal.throwIfAborted();
          failures += 1;
        }
      }
    }
  }
  // #endregion
}
