import { runWithOrganizationContext } from '@cadenway/nest-common';
import type {
  SystemTransactionRunner,
  TenantTransactionRunner,
  TransactionScope,
} from '@cadenway/nest-common/database';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';

import type { ProfileMediaCleanupLease } from '../../../../../application/models/media/profile-media-cleanup-lease.model.js';
import type { ProfileMediaCleanupSweep } from '../../../../../application/ports/outbound/persistence/media/profile-media-cleanup-sweep.port.js';
import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';
import { profileMediaCursors } from '../../schemas/media/profile-media.schema.js';
import type { DrizzleProfileMediaCleanupDiscovery } from './drizzle-profile-media-cleanup-discovery.repository.js';
import {
  DrizzleProfileMediaCleanupTransaction,
  deleteExpiredProfileMediaReceipts,
} from './drizzle-profile-media-cleanup-transaction.repository.js';

/** Coordinates bounded owner sweeps through a durable, exclusively leased cursor. */
export class DrizzleProfileMediaCleanup implements ProfileMediaCleanupSweep {
  // #region Constructor
  /** Runs discovery globally and object mutations in their exact owner scope. */
  public constructor(
    private readonly system: SystemTransactionRunner,
    private readonly tenant: TenantTransactionRunner,
    private readonly discovery: DrizzleProfileMediaCleanupDiscovery,
  ) {}
  // #endregion

  // #region Methods
  /** Discovers the next owner identifier in deterministic order. */
  public async nextOwner(
    after: ProfileMediaOwnerBinding | null,
  ): Promise<ProfileMediaOwnerBinding | null> {
    return (await this.discovery.listDueOwners(after, 1))[0] ?? null;
  }

  /** Claims one exact owner's due objects. */
  public claimOwner(
    owner: ProfileMediaOwnerBinding,
    limit: number,
  ): Promise<readonly ProfileMediaCleanupLease[]> {
    return this.inOwner(owner, (transaction) => transaction.claim(limit));
  }

  /** Removes bounded receipts for a deleted owner. */
  public purgeOwnerReceipts(owner: ProfileMediaOwnerBinding, limit: number): Promise<number> {
    return this.inOwner(owner, (transaction) => transaction.purgeDeletedReceipts(limit));
  }

  /** Compacts bounded upload metadata for a deleted owner. */
  public compactDeletedOwnerUploads(
    owner: ProfileMediaOwnerBinding,
    limit: number,
  ): Promise<number> {
    return this.inOwner(owner, (transaction) => transaction.compactDeletedUploads(limit));
  }

  /** Clears the owner cleanup marker only after all its work completes. */
  public finishOwner(owner: ProfileMediaOwnerBinding): Promise<boolean> {
    return this.inOwner(owner, (transaction) => transaction.finishDeletedOwner());
  }

  /** Deletes a bounded page of receipts after their replay retention. */
  public purgeExpiredReceipts(limit: number): Promise<number> {
    return this.system.run((scope) => deleteExpiredProfileMediaReceipts(scope, limit));
  }

  /** Commits a successful physical deletion against its exact owner and lease. */
  public complete(lease: ProfileMediaCleanupLease): Promise<void> {
    return this.inOwner(lease.owner, (transaction) => transaction.complete(lease));
  }

  /** Makes the unconfirmed objects of one owner eligible after a backoff. */
  public async release(leases: readonly ProfileMediaCleanupLease[]): Promise<void> {
    const owner = leases[0]?.owner;
    if (owner !== undefined) {
      await this.inOwner(owner, (transaction) => transaction.release(leases));
    }
  }

  private inOwner<T>(
    owner: ProfileMediaOwnerBinding,
    work: (transaction: DrizzleProfileMediaCleanupTransaction) => Promise<T>,
  ): Promise<T> {
    const run = (scope: TransactionScope) =>
      work(new DrizzleProfileMediaCleanupTransaction(scope, owner));
    if (owner.kind === 'avatar') return this.system.run(run);
    return runWithOrganizationContext(
      { organizationId: owner.id, actor: { type: 'system', id: null }, role: null, scopes: [] },
      () => this.tenant.run(run),
    );
  }

  public acquire(): Promise<{ readonly id: string; readonly continuation: string | null } | null> {
    return this.system.run(async ({ db }) => {
      const table = profileMediaCursors;
      const values = {
        leaseId: sql`uuidv7()`,
        leasedUntil: sql`clock_timestamp() + interval '30 seconds'`,
      };
      const [row] = await db
        .insert(table)
        .values({ scope: 'cleanup', ...values })
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
            eq(table.scope, 'cleanup'),
            eq(table.leaseId, id),
            gt(table.leasedUntil, sql`clock_timestamp()`),
          ),
        );
    });
  }

  public async releaseCursor(id: string): Promise<void> {
    await this.system.run(async ({ db }) => {
      const table = profileMediaCursors;
      await db
        .update(table)
        .set({ leaseId: null, leasedUntil: null })
        .where(and(eq(table.scope, 'cleanup'), eq(table.leaseId, id)));
    });
  }
  // #endregion
}
