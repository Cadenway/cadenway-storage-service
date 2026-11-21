import { organizationPolicy } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Serializes attachment lifecycle changes with permanent task revocation. */
export const attachmentTaskTombstones = pgTable(
  'attachment_task_tombstones',
  {
    organizationId: uuid('organization_id').notNull(),
    taskKey: text('task_key').notNull(),
    purgedAt: timestamp('purged_at', { withTimezone: true, precision: 3 }),
    purgeActorType: text('purge_actor_type'),
    purgeActorId: text('purge_actor_id'),
    cleanupPending: boolean('cleanup_pending').notNull().default(false),
  },
  (table) => [
    primaryKey({
      name: 'attachment_task_tombstones_pkey',
      columns: [table.organizationId, table.taskKey],
    }),
    index('attachment_task_tombstones_cleanup_index').on(
      table.organizationId,
      table.cleanupPending,
      table.taskKey,
    ),
    check(
      'attachment_task_tombstones_actor_check',
      sql`(${table.purgedAt} is null and ${table.purgeActorType} is null and ${table.purgeActorId} is null) or (${table.purgedAt} is not null and ${table.purgeActorType} is not null and ${table.purgeActorType} in ('user', 'automation', 'git', 'system') and ${table.purgeActorId} is not null)`,
    ),
    organizationPolicy('attachment_task_tombstones_organization_isolation'),
  ],
);
