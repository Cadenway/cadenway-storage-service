import type { TransactionScope } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';

import { attachments } from '../../schemas/attachment/attachments.schema.js';
import { intakeAttachments } from '../../schemas/attachment/intake-attachments.schema.js';

/** Serializes verified byte admissions and measures one tenant in the caller's transaction. */
export class DrizzleStorageQuota {
  // #region Properties
  /** Protects callers from measuring before the transaction-wide advisory lock is held. */
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
    await this.scope.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    this.locked = true;
  }

  /** Includes ready files and verified Intake reservations in the same SQL snapshot. */
  public async usedBytes(): Promise<bigint> {
    if (!this.locked) throw new Error('Storage quota must be locked before measuring usage.');
    const result = await this.scope.db.execute<{ used_bytes: string; isolation: string }>(sql`
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
      current_setting('transaction_isolation') as isolation
    `);
    const row = result.rows[0];
    if (row?.isolation !== 'read committed') {
      throw new Error('Storage quota admission requires a read committed transaction.');
    }
    const value = row.used_bytes;
    if (!/^\d+$/u.test(value)) {
      throw new Error('Storage quota usage could not be measured.');
    }
    return BigInt(value);
  }
  // #endregion
}
