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

import type { AttachmentObjectRetention } from '../../../../../application/models/attachment/attachment-object-retention.model.js';
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
    stagingBytes: integer('staging_bytes'),
    retention: text('retention').$type<AttachmentObjectRetention>().notNull().default('preserve'),
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
    check(
      'intake_attachment_candidates_staging_bytes_check',
      sql`${table.stagingBytes} is null or ${table.stagingBytes} between 1 and 26214400`,
    ),
    check(
      'intake_attachment_candidates_elected_history_check',
      sql`${table.retention} in ('preserve', 'candidate', 'transient') and (${table.status} <> 'elected' or ${table.retention} = 'preserve')`,
    ),
    organizationPolicy('intake_attachment_candidates_organization_isolation'),
  ],
);
