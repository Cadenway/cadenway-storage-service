import { organizationPolicy } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Tenant-owned reservations and verified attachment metadata. */
export const attachments = pgTable(
  'attachments',
  {
    organizationId: uuid('organization_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    taskKey: text('task_key').notNull(),
    authorUserId: uuid('author_user_id'),
    objectKey: text('object_key').notNull(),
    stagingObjectKey: text('staging_object_key').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status').notNull(),
    scanStatus: text('scan_status').notNull().default('pending'),
    version: integer('version').notNull(),
    reservedAt: timestamp('reserved_at', { withTimezone: true, precision: 3 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true, precision: 3 }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, precision: 3 }),
    electedObjectKey: text('elected_object_key'),
  },
  (table) => [
    primaryKey({ name: 'attachments_pkey', columns: [table.organizationId, table.id] }),
    index('attachments_task_page_index').on(
      table.organizationId,
      table.taskKey,
      table.status,
      table.uploadedAt,
      table.id,
    ),
    index('attachments_largest_page_index').on(
      table.organizationId,
      table.status,
      table.sizeBytes,
      table.id,
    ),
    index('attachments_task_purge_index')
      .on(table.organizationId, table.taskKey, table.id)
      .where(sql`${table.status} in ('pending', 'ready')`),
    check('attachments_status_check', sql`${table.status} in ('pending', 'ready', 'deleted')`),
    check('attachments_scan_status_check', sql`${table.scanStatus} in ('pending', 'verified')`),
    check('attachments_size_check', sql`${table.sizeBytes} between 1 and 26214400`),
    organizationPolicy('attachments_organization_isolation'),
  ],
);
