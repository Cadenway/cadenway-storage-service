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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { intakeAttachments } from './intake-attachments.schema.js';

/** Object candidates persist independently until a terminal Task decision permits cleanup. */
export const intakeAttachmentCandidates = pgTable(
  'intake_attachment_candidates',
  {
    organizationId: uuid('organization_id').notNull(),
    publicationId: uuid('publication_id').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    objectKey: text('object_key').notNull(),
    status: text('status').notNull(),
    cleanupAfter: timestamp('cleanup_after', { withTimezone: true, precision: 3 }).notNull(),
    cleanupGeneration: integer('cleanup_generation').notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: 'intake_attachment_candidates_pkey',
      columns: [table.organizationId, table.objectKey],
    }),
    foreignKey({
      name: 'intake_attachment_candidates_reservation_fkey',
      columns: [table.organizationId, table.publicationId, table.attachmentId],
      foreignColumns: [
        intakeAttachments.organizationId,
        intakeAttachments.publicationId,
        intakeAttachments.id,
      ],
    }),
    index('intake_attachment_candidates_cleanup_index')
      .on(table.organizationId, table.cleanupAfter, table.objectKey)
      .where(sql`${table.status} in ('staging', 'active', 'fenced')`),
    index('intake_attachment_candidates_reservation_index').on(
      table.organizationId,
      table.publicationId,
      table.attachmentId,
    ),
    uniqueIndex('intake_attachment_candidates_opaque_staging_key_unique')
      .on(table.objectKey)
      .where(sql`${table.objectKey} like 'intake/%'`),
    check(
      'intake_attachment_candidates_status_check',
      sql`${table.status} in ('staging', 'active', 'elected', 'fenced', 'cleaned')`,
    ),
    check('intake_attachment_candidates_generation_check', sql`${table.cleanupGeneration} >= 0`),
    organizationPolicy('intake_attachment_candidates_organization_isolation'),
  ],
);
