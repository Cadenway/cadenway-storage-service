import { organizationPolicy } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { attachments } from './attachments.schema.js';

/** Durable object candidates and cleanup fences, including delayed-copy tombstones. */
export const attachmentCandidates = pgTable(
  'attachment_candidates',
  {
    organizationId: uuid('organization_id').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    objectKey: text('object_key').notNull(),
    status: text('status').notNull().default('active'),
    cleanupAfter: timestamp('cleanup_after', { withTimezone: true, precision: 3 }).notNull(),
    cleanupGeneration: integer('cleanup_generation').notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: 'attachment_candidates_pkey',
      columns: [table.organizationId, table.objectKey],
    }),
    foreignKey({
      name: 'attachment_candidates_attachment_fkey',
      columns: [table.organizationId, table.attachmentId],
      foreignColumns: [attachments.organizationId, attachments.id],
    }),
    index('attachment_candidates_cleanup_index')
      .on(table.organizationId, table.cleanupAfter, table.objectKey)
      .where(sql`${table.status} in ('staging', 'active', 'fenced')`),
    check(
      'attachment_candidates_status_check',
      sql`${table.status} in ('staging', 'active', 'elected', 'fenced', 'cleaned')`,
    ),
    check('attachment_candidates_cleanup_generation_check', sql`${table.cleanupGeneration} >= 0`),
    organizationPolicy('attachment_candidates_organization_isolation'),
  ],
);
