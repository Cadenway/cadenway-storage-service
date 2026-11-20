import type { SystemTransactionRunner } from '@cadenway/nest-common/database';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';

import type { AttachmentObjectPage } from '../../../../../application/models/attachment/attachment-object-page.model.js';
import type { AttachmentReconciliationLease } from '../../../../../application/models/attachment/attachment-reconciliation-lease.model.js';
import type { AttachmentReconciliation } from '../../../../../application/ports/outbound/persistence/attachment/attachment-reconciliation.port.js';
import { attachmentCandidates } from '../../schemas/attachment/attachment-candidates.schema.js';
import { attachmentReconciliationCursors } from '../../schemas/attachment/attachment-reconciliation-cursors.schema.js';

const CURSOR_SCOPE = 'objects';
const leaseValues = {
  leaseId: sql`uuidv7()`,
  leasedUntil: sql`clock_timestamp() + interval '30 seconds'`,
};
const releasedLease = { leaseId: null, leasedUntil: null };

/** Coordinates physical inventory reconciliation through Storage's system runner. */
export class DrizzleAttachmentReconciliation implements AttachmentReconciliation {
  // #region Constructor
  /** Binds all short cursor and candidate writes to Storage's database. */
  public constructor(private readonly system: SystemTransactionRunner) {}
  // #endregion

  // #region Methods
  /** Claims the singleton position atomically, including recovery after an expired lease. */
  public acquire(): Promise<AttachmentReconciliationLease | null> {
    return this.system.run(async ({ db }) => {
      const cursor = attachmentReconciliationCursors;
      const [claim] = await db
        .insert(cursor)
        .values({ scope: CURSOR_SCOPE, ...leaseValues })
        .onConflictDoUpdate({
          target: cursor.scope,
          set: leaseValues,
          setWhere: or(isNull(cursor.leasedUntil), lte(cursor.leasedUntil, sql`clock_timestamp()`)),
        })
        .returning({ id: cursor.leaseId, continuation: cursor.continuation });
      return claim?.id ? { id: claim.id, continuation: claim.continuation } : null;
    });
  }

  /** Requeues only known cleaned tenant keys while a live owner advances the position. */
  public complete(leaseId: string, page: AttachmentObjectPage): Promise<number | null> {
    return this.system.run(async ({ db }) => {
      const cursor = attachmentReconciliationCursors;
      const [advanced] = await db
        .update(cursor)
        .set({ continuation: page.next, ...releasedLease })
        .where(
          and(
            eq(cursor.scope, CURSOR_SCOPE),
            eq(cursor.leaseId, leaseId),
            gt(cursor.leasedUntil, sql`clock_timestamp()`),
          ),
        )
        .returning({ scope: cursor.scope });
      if (advanced === undefined) return null;
      if (page.objects.length === 0) return 0;

      const keys = sql.join(
        page.objects.map(
          ({ organizationId, objectKey }) => sql`(${organizationId}::uuid, ${objectKey}::text)`,
        ),
        sql`, `,
      );
      const requeued = await db.execute(sql`
        update ${attachmentCandidates} as candidate
        set status = 'fenced',
            cleanup_after = clock_timestamp(),
            cleanup_generation = cleanup_generation + 1
        from (values ${keys}) as observed(organization_id, object_key)
        where candidate.organization_id = observed.organization_id
          and candidate.object_key = observed.object_key
          and candidate.status = 'cleaned'
      `);
      return requeued.rowCount ?? 0;
    });
  }

  /** Lets a later attempt resume the same page after the owner reports a failed request. */
  public release(leaseId: string): Promise<void> {
    return this.system.run(async ({ db }) => {
      const cursor = attachmentReconciliationCursors;
      await db
        .update(cursor)
        .set(releasedLease)
        .where(and(eq(cursor.scope, CURSOR_SCOPE), eq(cursor.leaseId, leaseId)));
    });
  }
  // #endregion
}
