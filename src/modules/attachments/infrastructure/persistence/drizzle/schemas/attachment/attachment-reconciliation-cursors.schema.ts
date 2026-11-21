import { SYSTEM_ACCESS_SETTING } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import { check, pgPolicy, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const systemOnly = sql.raw(`current_setting('${SYSTEM_ACCESS_SETTING}', true) = 'on'`);

/** Stores the resume position and exclusive short lease for one physical inventory pass. */
export const attachmentReconciliationCursors = pgTable(
  'attachment_reconciliation_cursors',
  {
    scope: text('scope').primaryKey(),
    continuation: text('continuation'),
    leaseId: uuid('lease_id'),
    leasedUntil: timestamp('leased_until', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    check('attachment_reconciliation_scope_check', sql`${table.scope} = 'objects'`),
    check(
      'attachment_reconciliation_lease_check',
      sql`(${table.leaseId} is null) = (${table.leasedUntil} is null)`,
    ),
    pgPolicy('attachment_reconciliation_system_access', {
      for: 'all',
      using: systemOnly,
      withCheck: systemOnly,
    }),
  ],
);
