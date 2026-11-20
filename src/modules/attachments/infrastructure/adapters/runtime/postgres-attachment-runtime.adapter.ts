import type { TenantTransactionRunner } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';

import type { AttachmentRuntime } from '../../../application/ports/outbound/runtime/attachment/attachment-runtime.port.js';

/** Gives attachment use cases a clock and UUIDv7 identifiers allocated by PostgreSQL. */
export class PostgresAttachmentRuntime implements AttachmentRuntime {
  // #region Constructor
  /** Binds identifier allocation to the verified tenant's database connection. */
  public constructor(private readonly runner: TenantTransactionRunner) {}
  // #endregion

  // #region Methods
  /** Reads the application clock without keeping a database connection open. */
  public now(): Date {
    return new Date();
  }

  /** Allocates an identifier through PostgreSQL's native UUIDv7 function. */
  public newId(): Promise<string> {
    return this.runner.run(async ({ db }) => {
      const result = await db.execute<{ readonly id: string }>(sql`select uuidv7()::text as id`);
      const id = result.rows[0]?.id;
      if (typeof id !== 'string') throw new Error('PostgreSQL did not return an attachment ID.');
      return id;
    });
  }
  // #endregion
}
