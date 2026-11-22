import type { SystemTransactionRunner, TransactionDatabase } from '@cadenway/nest-common/database';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';

import type { AttachmentObjectPage } from '../../../../../application/models/attachment/attachment-object-page.model.js';
import type { AttachmentReconciliationLease } from '../../../../../application/models/attachment/attachment-reconciliation-lease.model.js';
import type { IntakeAttachmentObjectPage } from '../../../../../application/models/intake-attachment/intake-attachment-object-page.model.js';
import type { AttachmentReconciliation } from '../../../../../application/ports/outbound/persistence/attachment/attachment-reconciliation.port.js';
import type { IntakeAttachmentReconciliation } from '../../../../../application/ports/outbound/persistence/intake-attachment/intake-attachment-reconciliation.port.js';
import { attachmentCandidates } from '../../schemas/attachment/attachment-candidates.schema.js';
import { attachmentReconciliationCursors } from '../../schemas/attachment/attachment-reconciliation-cursors.schema.js';
import { attachments } from '../../schemas/attachment/attachments.schema.js';
import { intakeAttachmentCandidates } from '../../schemas/attachment/intake-attachment-candidates.schema.js';

const leaseValues = {
  leaseId: sql`uuidv7()`,
  leasedUntil: sql`clock_timestamp() + interval '30 seconds'`,
};
const releasedLease = { leaseId: null, leasedUntil: null };

/** Coordinates one short, exclusive inventory lease for a storage namespace. */
class DrizzleAttachmentInventoryCursor {
  // #region Constructor
  /** Binds all short cursor and candidate writes to Storage's database. */
  public constructor(
    private readonly system: SystemTransactionRunner,
    private readonly scope: 'objects' | 'intake',
  ) {}
  // #endregion

  // #region Methods
  /** Claims the singleton position atomically, including recovery after an expired lease. */
  public acquire(): Promise<AttachmentReconciliationLease | null> {
    return this.system.run(async ({ db }) => {
      const cursor = attachmentReconciliationCursors;
      const [claim] = await db
        .insert(cursor)
        .values({ scope: this.scope, ...leaseValues })
        .onConflictDoUpdate({
          target: cursor.scope,
          set: leaseValues,
          setWhere: or(isNull(cursor.leasedUntil), lte(cursor.leasedUntil, sql`clock_timestamp()`)),
        })
        .returning({ id: cursor.leaseId, continuation: cursor.continuation });
      return claim?.id ? { id: claim.id, continuation: claim.continuation } : null;
    });
  }

  /** Advances a live lease and runs the caller's bounded updates atomically. */
  public complete(
    leaseId: string,
    next: string | null,
    requeue: (db: TransactionDatabase) => Promise<number>,
  ): Promise<number | null> {
    return this.system.run(async ({ db }) => {
      const cursor = attachmentReconciliationCursors;
      const [advanced] = await db
        .update(cursor)
        .set({ continuation: next, ...releasedLease })
        .where(
          and(
            eq(cursor.scope, this.scope),
            eq(cursor.leaseId, leaseId),
            gt(cursor.leasedUntil, sql`clock_timestamp()`),
          ),
        )
        .returning({ scope: cursor.scope });
      return advanced === undefined ? null : requeue(db);
    });
  }

  /** Lets a later attempt resume the same page after the owner reports a failed request. */
  public release(leaseId: string): Promise<void> {
    return this.system.run(async ({ db }) => {
      const cursor = attachmentReconciliationCursors;
      await db
        .update(cursor)
        .set(releasedLease)
        .where(and(eq(cursor.scope, this.scope), eq(cursor.leaseId, leaseId)));
    });
  }
  // #endregion
}

/** Coordinates physical inventory reconciliation for keys that embed a tenant. */
export class DrizzleAttachmentReconciliation implements AttachmentReconciliation {
  // #region Properties
  /** Exclusive cursor for the authenticated object namespace. */
  private readonly cursor: DrizzleAttachmentInventoryCursor;
  // #endregion

  // #region Constructor
  /** Binds the inventory position to the authenticated object namespace. */
  public constructor(system: SystemTransactionRunner) {
    this.cursor = new DrizzleAttachmentInventoryCursor(system, 'objects');
  }
  // #endregion

  // #region Methods
  /** Resumes the next page, if no other worker owns it. */
  public acquire(): Promise<AttachmentReconciliationLease | null> {
    return this.cursor.acquire();
  }

  /** Requeues only known cleaned tenant keys while a live owner advances the position. */
  public complete(leaseId: string, page: AttachmentObjectPage): Promise<number | null> {
    return this.cursor.complete(leaseId, page.next, async (db) => {
      if (page.objects.length === 0) return 0;

      const keys = sql.join(
        page.objects.map(
          ({ organizationId, objectKey, transientOnly }) =>
            sql`(${organizationId}::uuid, ${objectKey}::text, ${transientOnly ?? false}::boolean)`,
        ),
        sql`, `,
      );
      const knownStaging = sql`
        candidate.object_key = attachment.staging_object_key
        and candidate.object_key <> attachment.object_key
        and candidate.object_key is distinct from attachment.elected_object_key
      `;
      const requeued = await db.execute(sql`
        update ${attachmentCandidates} as candidate
        set status = 'fenced',
            cleanup_after = clock_timestamp(),
            cleanup_generation = cleanup_generation + 1,
            retention = case when ${knownStaging} then 'transient' else candidate.retention end
        from (values ${keys}) as observed(organization_id, object_key, transient_only),
             ${attachments} as attachment
        where candidate.organization_id = observed.organization_id
          and candidate.object_key = observed.object_key
          and candidate.organization_id = attachment.organization_id
          and candidate.attachment_id = attachment.id
          and candidate.status = 'cleaned'
          and (not observed.transient_only or candidate.retention = 'transient' or (${knownStaging}))
      `);
      const intakeRequeued = await db.execute(sql`
        update ${intakeAttachmentCandidates} as candidate
        set status = 'fenced',
            cleanup_after = clock_timestamp(),
            cleanup_generation = cleanup_generation + 1
        from (values ${keys}) as observed(organization_id, object_key, transient_only)
        where candidate.organization_id = observed.organization_id
          and candidate.object_key = observed.object_key
          and candidate.status = 'cleaned'
          and (not observed.transient_only or candidate.retention = 'transient')
          and not exists (
            select 1 from ${attachmentCandidates} as ordinary
            where ordinary.organization_id = candidate.organization_id
              and ordinary.object_key = candidate.object_key
              and ordinary.status <> 'cleaned'
          )
      `);
      return (requeued.rowCount ?? 0) + (intakeRequeued.rowCount ?? 0);
    });
  }

  /** Lets a later attempt resume the same page after the owner reports a failed request. */
  public release(leaseId: string): Promise<void> {
    return this.cursor.release(leaseId);
  }
  // #endregion
}

/** Reconciles opaque staging objects against the unique, service-owned Intake ledger. */
export class DrizzleIntakeAttachmentReconciliation implements IntakeAttachmentReconciliation {
  // #region Properties
  /** Exclusive cursor for the opaque staging namespace. */
  private readonly cursor: DrizzleAttachmentInventoryCursor;
  // #endregion

  // #region Constructor
  /** Binds a system-only job to its own namespace and cursor. */
  public constructor(system: SystemTransactionRunner) {
    this.cursor = new DrizzleAttachmentInventoryCursor(system, 'intake');
  }
  // #endregion

  // #region Methods
  /** Resumes the next opaque page, if no other worker owns it. */
  public acquire(): Promise<AttachmentReconciliationLease | null> {
    return this.cursor.acquire();
  }

  /** Rearms a known cleaned key that appeared again after the signed upload finished late. */
  public complete(leaseId: string, page: IntakeAttachmentObjectPage): Promise<number | null> {
    return this.cursor.complete(leaseId, page.next, async (db) => {
      if (page.objects.length === 0) return 0;
      const keys = sql.join(
        page.objects.map(({ objectKey }) => sql`(${objectKey}::text)`),
        sql`, `,
      );
      // Intake never elects an object from its opaque staging namespace.
      const requeued = await db.execute(sql`
        update ${intakeAttachmentCandidates} as candidate
        set status = 'fenced',
            cleanup_after = clock_timestamp(),
            cleanup_generation = cleanup_generation + 1,
            retention = 'transient'
        from (values ${keys}) as observed(object_key)
        where candidate.object_key like 'intake/%'
          and candidate.object_key = observed.object_key
          and candidate.status = 'cleaned'
      `);
      return requeued.rowCount ?? 0;
    });
  }

  /** Leaves the same page available to the next attempt. */
  public release(leaseId: string): Promise<void> {
    return this.cursor.release(leaseId);
  }
  // #endregion
}
