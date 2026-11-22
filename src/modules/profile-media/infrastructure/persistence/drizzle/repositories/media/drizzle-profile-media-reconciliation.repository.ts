import { runWithOrganizationContext } from '@cadenway/nest-common';
import type {
  SystemTransactionRunner,
  TenantTransactionRunner,
  TransactionScope,
} from '@cadenway/nest-common/database';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';

import type { ProfileMediaReconciliation } from '../../../../../application/ports/outbound/persistence/media/profile-media-reconciliation.port.js';
import type { ProfileMediaObjectPage } from '../../../../../application/models/media/profile-media-object-page.model.js';
import type { ProfileMediaReconciliationObservation } from '../../../../../application/models/media/profile-media-reconciliation-observation.model.js';
import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';
import {
  profileMediaCursors,
  profileMediaObjects,
} from '../../schemas/media/profile-media.schema.js';
import { DrizzleProfileMediaCleanupTransaction } from './drizzle-profile-media-cleanup-transaction.repository.js';

/** Persists inventory progress and rechecks owner-scoped ledger entries. */
export class DrizzleProfileMediaReconciliation implements ProfileMediaReconciliation {
  // #region Constructor
  /** Binds the system discovery and verified tenant runners. */
  public constructor(
    private readonly system: SystemTransactionRunner,
    private readonly tenant: TenantTransactionRunner,
  ) {}
  // #endregion

  // #region Methods
  /** Rechecks observed candidates in the owner's transaction. */
  public requeue(
    owner: ProfileMediaOwnerBinding,
    observations: readonly ProfileMediaReconciliationObservation[],
  ): Promise<number> {
    const work = (scope: TransactionScope) =>
      new DrizzleProfileMediaCleanupTransaction(scope, owner).requeueObserved(observations);
    return owner.kind === 'avatar'
      ? this.system.run(work)
      : runWithOrganizationContext(
          { organizationId: owner.id, actor: { type: 'system', id: null }, role: null, scopes: [] },
          () => this.tenant.run(work),
        );
  }
  public resolve(
    objects: ProfileMediaObjectPage['objects'],
  ): Promise<readonly ProfileMediaReconciliationObservation[]> {
    if (objects.length === 0) return Promise.resolve([]);
    const keys = sql.join(
      objects.map(
        (item) =>
          sql`(${item.role}::text, ${item.objectId}::uuid, ${item.transientOnly ?? false}::boolean)`,
      ),
      sql`, `,
    );
    return this.system.run(
      async ({ db }) => {
        const table = profileMediaObjects;
        const rows = await db.execute<
          ProfileMediaReconciliationObservation & Record<string, unknown>
        >(sql`
        select ${table.ownerKind} as kind, ${table.ownerId} as "ownerId", ${table.uploadId} as "uploadId", ${table.objectId} as "objectId", ${table.role} as role
        from ${table} join (values ${keys}) as observed(role, object_id, transient_only)
          on ${table.role} = observed.role and ${table.objectId} = observed.object_id
        where ${table.status} = 'cleaned' and (not observed.transient_only or ${table.retention} = 'transient')
      `);
        return rows.rows;
      },
      { readOnly: true },
    );
  }

  public acquire(): Promise<{ readonly id: string; readonly continuation: string | null } | null> {
    return this.system.run(async ({ db }) => {
      const table = profileMediaCursors;
      const values = {
        leaseId: sql`uuidv7()`,
        leasedUntil: sql`clock_timestamp() + interval '60 seconds'`,
      };
      const [row] = await db
        .insert(table)
        .values({ scope: 'inventory', ...values })
        .onConflictDoUpdate({
          target: table.scope,
          set: values,
          setWhere: or(isNull(table.leasedUntil), lte(table.leasedUntil, sql`clock_timestamp()`)),
        })
        .returning({ id: table.leaseId, continuation: table.continuation });
      return row?.id ? { id: row.id, continuation: row.continuation } : null;
    });
  }

  public async advance(id: string, continuation: string | null): Promise<void> {
    await this.system.run(async ({ db }) => {
      const table = profileMediaCursors;
      await db
        .update(table)
        .set({ continuation, leaseId: null, leasedUntil: null })
        .where(
          and(
            eq(table.scope, 'inventory'),
            eq(table.leaseId, id),
            gt(table.leasedUntil, sql`clock_timestamp()`),
          ),
        );
    });
  }

  public async release(id: string): Promise<void> {
    await this.system.run(async ({ db }) => {
      const table = profileMediaCursors;
      await db
        .update(table)
        .set({ leaseId: null, leasedUntil: null })
        .where(and(eq(table.scope, 'inventory'), eq(table.leaseId, id)));
    });
  }
  // #endregion
}
