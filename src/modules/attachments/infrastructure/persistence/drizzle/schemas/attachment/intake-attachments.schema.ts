import { organizationPolicy } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Tenant-owned reservation and its durable terminal decision, including release-before-start. */
export const intakeAttachments = pgTable(
  'intake_attachments',
  {
    organizationId: uuid('organization_id').notNull(),
    publicationId: uuid('publication_id').notNull(),
    id: uuid('id').notNull(),
    status: text('status').notNull(),
    stagingObjectKey: text('staging_object_key'),
    fileName: text('file_name'),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    reservedAt: timestamp('reserved_at', { withTimezone: true, precision: 3 }),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }),
    uploadExpiresAt: timestamp('upload_expires_at', { withTimezone: true, precision: 3 }),
    candidateKey: text('candidate_key'),
    verifiedAt: timestamp('verified_at', { withTimezone: true, precision: 3 }),
    taskKey: text('task_key'),
    decidedAt: timestamp('decided_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    primaryKey({
      name: 'intake_attachments_pkey',
      columns: [table.organizationId, table.publicationId, table.id],
    }),
    check(
      'intake_attachments_status_check',
      sql`${table.status} in ('pending', 'verified', 'claimed', 'released')`,
    ),
    check(
      'intake_attachments_reservation_check',
      sql`num_nonnulls(${table.stagingObjectKey}, ${table.fileName}, ${table.contentType}, ${table.sizeBytes}, ${table.reservedAt}, ${table.expiresAt}, ${table.uploadExpiresAt}) in (0, 7)`,
    ),
    check(
      'intake_attachments_size_check',
      sql`${table.sizeBytes} is null or ${table.sizeBytes} between 1 and 26214400`,
    ),
    check(
      'intake_attachments_lifecycle_check',
      sql`(
        (${table.status} = 'pending' and ${table.stagingObjectKey} is not null and ${table.candidateKey} is null and ${table.verifiedAt} is null and ${table.taskKey} is null and ${table.decidedAt} is null)
        or (${table.status} = 'verified' and ${table.stagingObjectKey} is not null and ${table.candidateKey} is not null and ${table.verifiedAt} is not null and ${table.taskKey} is null and ${table.decidedAt} is null)
        or (${table.status} = 'claimed' and ${table.taskKey} is not null and ${table.decidedAt} is not null)
        or (${table.status} = 'released' and ${table.taskKey} is null and ${table.decidedAt} is not null)
      )`,
    ),
    organizationPolicy('intake_attachments_organization_isolation'),
  ],
);
