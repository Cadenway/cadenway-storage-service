import { organizationPolicy } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** A short upload lease or encrypted replay response for a single tenant, actor and task. */
export const attachmentUploadClaims = pgTable(
  'attachment_upload_claims',
  {
    organizationId: uuid('organization_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    taskKey: text('task_key').notNull(),
    keyDigest: text('key_digest').notNull(),
    fingerprint: text('fingerprint').notNull(),
    claimId: uuid('claim_id')
      .notNull()
      .default(sql`uuidv7()`),
    keyId: text('key_id'),
    nonce: bytea('nonce'),
    ciphertext: bytea('ciphertext'),
    authTag: bytea('auth_tag'),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'attachment_upload_claims_pkey',
      columns: [table.organizationId, table.actorId, table.taskKey, table.keyDigest],
    }),
    // Tenant lookups use the primary key. The system janitor walks expired rows across tenants.
    index('attachment_upload_claims_expiry_index').on(
      table.expiresAt,
      table.organizationId,
      table.actorId,
      table.taskKey,
      table.keyDigest,
    ),
    check('attachment_upload_claims_nonce_length', sql`octet_length(${table.nonce}) = 12`),
    check('attachment_upload_claims_auth_tag_length', sql`octet_length(${table.authTag}) = 16`),
    check(
      'attachment_upload_claims_receipt_shape',
      sql`num_nonnulls(${table.keyId}, ${table.nonce}, ${table.ciphertext}, ${table.authTag}) in (0, 4)`,
    ),
    organizationPolicy('attachment_upload_claims_organization_isolation'),
  ],
);
