import type { SystemTransactionRunner } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';

import type { ExpiredUploadReceipts } from '../../../../../application/ports/outbound/persistence/attachment/expired-upload-receipts.port.js';
import { attachmentUploadClaims } from '../../schemas/attachment/attachment-upload-claims.schema.js';

/** Deletes expired upload claims across tenants without reading their encrypted responses. */
export class DrizzleExpiredUploadReceipts implements ExpiredUploadReceipts {
  // #region Constructor
  /** Opens each batch with the service's system transaction runner. */
  public constructor(private readonly system: SystemTransactionRunner) {}
  // #endregion

  // #region Methods
  /** Skips locked claims and deletes the selected keys only while their receipts are expired. */
  public deleteBatch(limit: number): Promise<number> {
    return this.system.run(async ({ db }) => {
      const removed = await db.execute(sql`
        with expired as (
          select organization_id, actor_id, task_key, key_digest
          from ${attachmentUploadClaims}
          where expires_at <= statement_timestamp()
          order by expires_at, organization_id, actor_id, task_key, key_digest
          limit ${limit}
          for update skip locked
        )
        delete from ${attachmentUploadClaims} as receipt
        using expired
        where receipt.organization_id = expired.organization_id
          and receipt.actor_id = expired.actor_id
          and receipt.task_key = expired.task_key
          and receipt.key_digest = expired.key_digest
          and receipt.expires_at <= statement_timestamp()
      `);
      return removed.rowCount ?? 0;
    });
  }
  // #endregion
}
