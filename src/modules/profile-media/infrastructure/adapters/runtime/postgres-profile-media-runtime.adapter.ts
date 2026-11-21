import type { SystemTransactionRunner } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';

import type { ProfileMediaRuntime } from '../../../application/ports/outbound/runtime/media/profile-media-runtime.port.js';

/** Gives media operations a clock and UUIDv7 identifiers without reading owner data. */
export class PostgresProfileMediaRuntime implements ProfileMediaRuntime {
  // #region Constructor
  /** Binds the service's database to allocate UUIDs outside an owner transaction. */
  public constructor(private readonly system: SystemTransactionRunner) {}
  // #endregion

  // #region Methods
  /** Uses the application clock without acquiring a database connection. */
  public now(): Date {
    return new Date();
  }

  /** Allocates one UUIDv7 through PostgreSQL. */
  public newId(): Promise<string> {
    return this.system.run(
      async ({ db }) => {
        const result = await db.execute<{ readonly id: string }>(sql`select uuidv7()::text as id`);
        const id = result.rows[0]?.id;
        if (id === undefined) throw new Error('PostgreSQL did not return a profile candidate ID.');
        return id;
      },
      { readOnly: true },
    );
  }
  // #endregion
}
