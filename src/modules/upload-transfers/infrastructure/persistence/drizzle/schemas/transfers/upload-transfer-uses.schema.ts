import { SYSTEM_ACCESS_SETTING } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import { index, pgPolicy, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const systemOnly = sql.raw(`current_setting('${SYSTEM_ACCESS_SETTING}', true) = 'on'`);

/** Durable admission records for reserved one-shot staging writes. */
export const uploadTransferUses = pgTable(
  'upload_transfer_uses',
  {
    stagingDigest: text('staging_digest').primaryKey(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('upload_transfer_uses_expiry_index').on(table.retainUntil, table.stagingDigest),
    pgPolicy('upload_transfer_uses_system_only', {
      as: 'permissive',
      for: 'all',
      using: systemOnly,
      withCheck: systemOnly,
    }),
  ],
);
