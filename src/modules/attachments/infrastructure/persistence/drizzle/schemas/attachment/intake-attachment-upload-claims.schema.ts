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

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** Short signing lease and encrypted capability receipt for one immutable allocation. */
export const intakeAttachmentUploadClaims = pgTable(
  'intake_attachment_upload_claims',
  {
    organizationId: uuid('organization_id').notNull(),
    publicationId: uuid('publication_id').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
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
      name: 'intake_attachment_upload_claims_pkey',
      columns: [table.organizationId, table.publicationId, table.attachmentId],
    }),
    index('intake_attachment_upload_claims_expiry_index').on(
      table.expiresAt,
      table.organizationId,
      table.publicationId,
      table.attachmentId,
    ),
    check('intake_attachment_upload_claims_nonce_check', sql`octet_length(${table.nonce}) = 12`),
    check('intake_attachment_upload_claims_tag_check', sql`octet_length(${table.authTag}) = 16`),
    check(
      'intake_attachment_upload_claims_receipt_check',
      sql`num_nonnulls(${table.keyId}, ${table.nonce}, ${table.ciphertext}, ${table.authTag}) in (0, 4)`,
    ),
    organizationPolicy('intake_attachment_upload_claims_organization_isolation'),
  ],
);
