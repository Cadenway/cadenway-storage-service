import { organizationPolicy } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';

/** Latest committed byte limit received for one organization. */
export const storageByteEntitlements = pgTable(
  'storage_byte_entitlements',
  {
    organizationId: uuid('organization_id').notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    limitBytes: bigint('limit_bytes', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'storage_byte_entitlements_pkey',
      columns: [table.organizationId],
    }),
    check(
      'storage_byte_entitlements_version_check',
      sql`${table.version} between 1 and 9007199254740991`,
    ),
    check(
      'storage_byte_entitlements_limit_check',
      sql`${table.limitBytes} between 2000000000 and 9007199254740991`,
    ),
    organizationPolicy('storage_byte_entitlements_organization_isolation'),
  ],
);
