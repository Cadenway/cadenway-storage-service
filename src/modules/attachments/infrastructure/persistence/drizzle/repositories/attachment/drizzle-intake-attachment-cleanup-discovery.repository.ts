import type { SystemTransactionRunner } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';

import type { IntakeAttachmentCleanupDiscovery } from '../../../../../application/ports/outbound/persistence/intake-attachment/intake-attachment-cleanup-discovery.port.js';
import { intakeAttachmentCandidates } from '../../schemas/attachment/intake-attachment-candidates.schema.js';

const PAGE_SIZE = 100;

/** Finds due organizations using the system scan; all actual mutations re-enter tenant scope. */
export class DrizzleIntakeAttachmentCleanupDiscovery implements IntakeAttachmentCleanupDiscovery {
  // #region Constructor
  /** Binds the system runner for bounded organization discovery. */
  public constructor(private readonly system: SystemTransactionRunner) {}
  // #endregion

  // #region Methods
  /** Seeks each tenant with at least one due non-elected candidate. */
  public listDueObjectOrganizations(
    cutoff: Date,
    after: string | null,
  ): Promise<readonly string[]> {
    const { organizationId, status, cleanupAfter } = intakeAttachmentCandidates;
    const due = sql`${status} in ('staging', 'active', 'fenced') and ${cleanupAfter} <= ${cutoff.toISOString()}::timestamptz`;
    const lowerBound = after === null ? sql.empty() : sql`and ${organizationId} > ${after}::uuid`;
    return this.system.run(
      async ({ db }) => {
        const result = await db.execute<{ organizationId: string }>(sql`
        with recursive due_tenants (organization_id, page_index) as (
          (select ${organizationId}, 1 from ${intakeAttachmentCandidates}
           where ${due} ${lowerBound} order by ${organizationId} limit 1)
          union all
          select next_tenant.organization_id, due_tenants.page_index + 1
          from due_tenants cross join lateral (
            select ${organizationId} from ${intakeAttachmentCandidates}
            where ${due} and ${organizationId} > due_tenants.organization_id
            order by ${organizationId} limit 1
          ) as next_tenant where due_tenants.page_index < ${PAGE_SIZE}
        )
        select organization_id as "organizationId" from due_tenants order by organization_id
      `);
        return result.rows.map((row) => row.organizationId);
      },
      { readOnly: true },
    );
  }
  // #endregion
}
