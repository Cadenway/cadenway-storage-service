import type { TransactionScope } from '@cadenway/nest-common/database';
import { eq, sql } from 'drizzle-orm';

import type { StorageQuotaAdmission } from '../../../../../application/models/attachment/storage-quota-admission.model.js';
import { freeStorageEntitlement } from '../../../../../domain/policies/attachment/storage-entitlement.policy.js';
import type { StorageEntitlement } from '../../../../../domain/value-objects/attachment/storage-entitlement.value-object.js';
import { attachments } from '../../schemas/attachment/attachments.schema.js';
import { intakeAttachments } from '../../schemas/attachment/intake-attachments.schema.js';
import { storageByteEntitlements } from '../../schemas/attachment/storage-byte-entitlements.schema.js';

/** Serializes byte admissions and Billing entitlement changes in the tenant transaction. */
export class DrizzleStorageQuota {
  // #region Properties
  /** Protects admission and projection operations before the advisory lock is held. */
  private locked = false;
  // #endregion

  // #region Constructor
  /** Binds the verified tenant transaction shared with attachment election. */
  public constructor(
    private readonly scope: TransactionScope,
    private readonly organizationId: string,
  ) {}
  // #endregion

  // #region Methods
  /** Takes a tenant-specific transaction lock before a fresh READ COMMITTED statement. */
  public async lock(): Promise<void> {
    const key = `storage-quota:${this.organizationId}`;
    const result = await this.scope.db.execute<{ isolation: string }>(sql`
      select pg_advisory_xact_lock(hashtextextended(${key}, 0)),
             current_setting('transaction_isolation') as isolation
    `);
    if (result.rows[0]?.isolation !== 'read committed') {
      throw new Error('Storage quota admission requires a read committed transaction.');
    }
    this.locked = true;
  }

  /** Reads the effective limit, ready files and verified Intake reservations in one snapshot. */
  public async admission(): Promise<StorageQuotaAdmission> {
    this.requireLock();
    const result = await this.scope.db.execute<{ used_bytes: string; limit_bytes: string }>(sql`
      select (
        coalesce((
          select sum(${attachments.sizeBytes}::numeric)
          from ${attachments}
          where ${attachments.organizationId} = ${this.organizationId}
            and ${attachments.status} = 'ready'
        ), 0) +
        coalesce((
          select sum(${intakeAttachments.sizeBytes}::numeric)
          from ${intakeAttachments}
          where ${intakeAttachments.organizationId} = ${this.organizationId}
            and ${intakeAttachments.status} = 'verified'
        ), 0)
      )::text as used_bytes,
      coalesce((
        select ${storageByteEntitlements.limitBytes}
        from ${storageByteEntitlements}
        where ${storageByteEntitlements.organizationId} = ${this.organizationId}
      ), ${freeStorageEntitlement.limitBytes}::bigint)::text as limit_bytes
    `);
    const row = result.rows[0];
    if (row === undefined || !/^\d+$/u.test(row.used_bytes) || !/^\d+$/u.test(row.limit_bytes)) {
      throw new Error('Storage quota usage could not be measured.');
    }
    return { usedBytes: BigInt(row.used_bytes), limitBytes: BigInt(row.limit_bytes) };
  }

  /** Reads the latest committed Billing version after acquiring the tenant lock. */
  public async entitlement(): Promise<StorageEntitlement> {
    this.requireLock();
    const [row] = await this.scope.db
      .select({
        version: storageByteEntitlements.version,
        limitBytes: storageByteEntitlements.limitBytes,
      })
      .from(storageByteEntitlements)
      .where(eq(storageByteEntitlements.organizationId, this.organizationId));
    return row ?? freeStorageEntitlement;
  }

  /** Persists the accepted version and limit in the same transaction as the locked read. */
  public async saveEntitlement(entitlement: StorageEntitlement): Promise<void> {
    this.requireLock();
    const { version, limitBytes } = entitlement;
    await this.scope.db
      .insert(storageByteEntitlements)
      .values({ organizationId: this.organizationId, version, limitBytes })
      .onConflictDoUpdate({
        target: storageByteEntitlements.organizationId,
        set: { version, limitBytes },
      });
  }

  private requireLock(): void {
    if (!this.locked)
      throw new Error('Storage quota must be locked before inspecting or changing it.');
  }
  // #endregion
}
