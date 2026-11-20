import type { SystemTransactionRunner } from '@cadenway/nest-common/database';
import { and, asc, sql } from 'drizzle-orm';

import type { AttachmentCleanupTask } from '../../../../../application/models/attachment/attachment-cleanup-task.model.js';
import type { AttachmentCleanupDiscovery } from '../../../../../application/ports/outbound/persistence/attachment/attachment-cleanup-discovery.port.js';
import { attachmentCandidates } from '../../schemas/attachment/attachment-candidates.schema.js';
import { attachmentTaskTombstones } from '../../schemas/attachment/attachment-task-tombstones.schema.js';

const DISCOVERY_PAGE_SIZE = 100;

/** Discovers pending work using short read-only system transactions. */
export class DrizzleAttachmentCleanupDiscovery implements AttachmentCleanupDiscovery {
  // #region Constructor
  /** Binds the service's system transaction runner. */
  public constructor(private readonly system: SystemTransactionRunner) {}
  // #endregion

  // #region Methods
  /** Reads only pending tombstone keys in organization and task key order. */
  public listPurgedTasks(
    after: AttachmentCleanupTask | null,
  ): Promise<readonly AttachmentCleanupTask[]> {
    const { organizationId, taskKey, cleanupPending } = attachmentTaskTombstones;
    return this.system.run(
      async ({ db }) =>
        db
          .select({ organizationId, taskKey })
          .from(attachmentTaskTombstones)
          .where(
            and(
              sql`${cleanupPending} = true`,
              after === null
                ? undefined
                : sql`(${organizationId}, ${taskKey}) > (${after.organizationId}, ${after.taskKey})`,
            ),
          )
          .orderBy(asc(organizationId), asc(taskKey))
          .limit(DISCOVERY_PAGE_SIZE),
      { readOnly: true },
    );
  }

  /** Reads each organization once per sweep, ignoring elected and future objects. */
  public listDueObjectOrganizations(
    cutoff: Date,
    after: string | null,
  ): Promise<readonly string[]> {
    const { organizationId, status, cleanupAfter } = attachmentCandidates;
    const due = sql`${status} in ('staging', 'active', 'fenced')
      and ${cleanupAfter} <= ${cutoff.toISOString()}::timestamptz`;
    const lowerBound = after === null ? sql.empty() : sql`and ${organizationId} > ${after}::uuid`;
    return this.system.run(
      async ({ db }) => {
        // Seek past each tenant's full key range after finding its first due object.
        const tenants = await db.execute<{ organizationId: string }>(sql`
          with recursive due_tenants (organization_id, page_index) as (
            (
              select ${organizationId}, 1
              from ${attachmentCandidates}
              where ${due} ${lowerBound}
              order by ${organizationId}
              limit 1
            )
            union all
            select next_tenant.organization_id, due_tenants.page_index + 1
            from due_tenants
            cross join lateral (
              select ${organizationId}
              from ${attachmentCandidates}
              where ${due} and ${organizationId} > due_tenants.organization_id
              order by ${organizationId}
              limit 1
            ) as next_tenant
            where due_tenants.page_index < ${DISCOVERY_PAGE_SIZE}
          )
          select organization_id as "organizationId" from due_tenants order by organization_id
        `);
        return tenants.rows.map((tenant) => tenant.organizationId);
      },
      { readOnly: true },
    );
  }
  // #endregion
}
