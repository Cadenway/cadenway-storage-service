import { organizationPolicy, SYSTEM_ACCESS_SETTING } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  pgPolicy,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const instant = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });
const systemOnly = sql.raw(`current_setting('${SYSTEM_ACCESS_SETTING}', true) = 'on'`);

/** Durable independently leased cursors for bounded cleanup and physical inventory. */
export const profileMediaCursors = pgTable(
  'profile_media_cursors',
  {
    scope: text('scope').primaryKey(),
    continuation: text('continuation'),
    leaseId: uuid('lease_id'),
    leasedUntil: instant('leased_until'),
  },
  (t) => [
    check('profile_media_cursors_scope_check', sql`${t.scope} in ('cleanup', 'inventory')`),
    check(
      'profile_media_cursors_lease_check',
      sql`(${t.leaseId} is null) = (${t.leasedUntil} is null)`,
    ),
    pgPolicy('profile_media_cursors_system_access', {
      for: 'all',
      using: systemOnly,
      withCheck: systemOnly,
    }),
  ],
);

/** Durable owner generation and irreversible account deletion fence. */
export const profileMediaOwners = pgTable(
  'profile_media_owners',
  {
    organizationId: uuid('organization_id'),
    ownerKind: text('owner_kind').notNull(),
    ownerId: uuid('owner_id').notNull(),
    generation: bigint('generation', { mode: 'number' }).notNull().default(0),
    assetId: uuid('asset_id'),
    deleted: boolean('deleted').notNull().default(false),
    cleanupRequested: boolean('cleanup_requested').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.ownerKind, t.ownerId] }),
    index('profile_media_owners_tenant_idx').on(t.organizationId, t.ownerKind, t.ownerId),
    index('profile_media_owners_cleanup_idx')
      .on(t.ownerKind, t.ownerId)
      .where(sql`${t.cleanupRequested} = true`),
    check(
      'profile_media_owners_scope_check',
      sql`(${t.ownerKind} = 'avatar' and ${t.organizationId} is null) or (${t.ownerKind} = 'organization-logo' and ${t.organizationId} is not null and ${t.organizationId} = ${t.ownerId})`,
    ),
    check(
      'profile_media_owners_generation_check',
      sql`${t.generation} between 0 and 9007199254740991 and (not ${t.deleted} or ${t.assetId} is null)`,
    ),
    organizationPolicy('profile_media_owners_organization_isolation'),
  ],
);

/** Owner-bound upload declaration and permanent terminal decision. */
export const profileMediaUploads = pgTable(
  'profile_media_uploads',
  {
    organizationId: uuid('organization_id'),
    ownerKind: text('owner_kind').notNull(),
    ownerId: uuid('owner_id').notNull(),
    uploadId: uuid('upload_id').notNull(),
    status: text('status').notNull(),
    uploaderUserId: uuid('uploader_user_id'),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    expiresAt: instant('expires_at'),
    candidateId: uuid('candidate_id'),
    width: integer('width'),
    height: integer('height'),
    derivativeSizeBytes: integer('derivative_size_bytes'),
  },
  (t) => [
    primaryKey({ columns: [t.ownerKind, t.ownerId, t.uploadId] }),
    foreignKey({
      columns: [t.ownerKind, t.ownerId],
      foreignColumns: [profileMediaOwners.ownerKind, profileMediaOwners.ownerId],
      name: 'profile_media_uploads_owner_fk',
    }),
    index('profile_media_uploads_tenant_idx').on(
      t.organizationId,
      t.ownerKind,
      t.ownerId,
      t.uploadId,
    ),
    index('profile_media_uploads_pending_expiry_idx')
      .on(t.expiresAt, t.ownerKind, t.ownerId, t.uploadId)
      .where(sql`${t.status} = 'pending'`),
    index('profile_media_uploads_compaction_idx')
      .on(t.ownerKind, t.ownerId, t.uploadId)
      .where(sql`${t.uploaderUserId} is not null or ${t.candidateId} is not null`),
    check(
      'profile_media_uploads_scope_check',
      sql`(${t.ownerKind} = 'avatar' and ${t.organizationId} is null) or (${t.ownerKind} = 'organization-logo' and ${t.organizationId} is not null and ${t.organizationId} = ${t.ownerId})`,
    ),
    check(
      'profile_media_uploads_status_check',
      sql`${t.status} in ('pending','prepared','attached','retired')`,
    ),
    check(
      'profile_media_uploads_declaration_check',
      sql`num_nonnulls(${t.uploaderUserId},${t.contentType},${t.sizeBytes},${t.expiresAt}) in (0,4) and (${t.status} = 'retired' or ${t.uploaderUserId} is not null)`,
    ),
    check(
      'profile_media_uploads_derivative_check',
      sql`num_nonnulls(${t.candidateId},${t.width},${t.height},${t.derivativeSizeBytes}) in (0,4) and (${t.status} not in ('prepared','attached') or ${t.candidateId} is not null) and (${t.status} <> 'pending' or ${t.candidateId} is null)`,
    ),
    organizationPolicy('profile_media_uploads_organization_isolation'),
  ],
);

/** Immutable source and derivative objects with generation-fenced cleanup leases. */
export const profileMediaObjects = pgTable(
  'profile_media_objects',
  {
    organizationId: uuid('organization_id'),
    ownerKind: text('owner_kind').notNull(),
    ownerId: uuid('owner_id').notNull(),
    uploadId: uuid('upload_id').notNull(),
    objectId: uuid('object_id').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull(),
    retention: text('retention')
      .$type<'preserve' | 'candidate' | 'transient'>()
      .notNull()
      .default('preserve'),
    cleanupAfter: instant('cleanup_after').notNull(),
    generation: integer('generation').notNull().default(0),
    leaseId: uuid('lease_id'),
    leasedUntil: instant('leased_until'),
  },
  (t) => [
    primaryKey({ columns: [t.ownerKind, t.ownerId, t.uploadId, t.objectId] }),
    uniqueIndex('profile_media_objects_physical_key_idx').on(t.role, t.objectId),
    foreignKey({
      columns: [t.ownerKind, t.ownerId, t.uploadId],
      foreignColumns: [
        profileMediaUploads.ownerKind,
        profileMediaUploads.ownerId,
        profileMediaUploads.uploadId,
      ],
      name: 'profile_media_objects_upload_fk',
    }),
    index('profile_media_objects_tenant_idx').on(
      t.organizationId,
      t.ownerKind,
      t.ownerId,
      t.uploadId,
    ),
    index('profile_media_objects_due_idx')
      .on(t.cleanupAfter, t.ownerKind, t.ownerId, t.uploadId, t.objectId)
      .where(sql`${t.status} in ('active','fenced')`),
    check(
      'profile_media_objects_scope_check',
      sql`(${t.ownerKind} = 'avatar' and ${t.organizationId} is null) or (${t.ownerKind} = 'organization-logo' and ${t.organizationId} is not null and ${t.organizationId} = ${t.ownerId})`,
    ),
    check(
      'profile_media_objects_status_check',
      sql`${t.role} in ('staging','candidate') and ${t.status} in ('active','elected','fenced','cleaned')`,
    ),
    check(
      'profile_media_objects_retention_check',
      sql`${t.retention} in ('preserve','candidate','transient') and (${t.status} <> 'elected' or ${t.retention} = 'preserve')`,
    ),
    check(
      'profile_media_objects_identity_check',
      sql`(${t.role} = 'staging' and ${t.objectId} = ${t.uploadId}) or (${t.role} = 'candidate' and ${t.objectId} <> ${t.uploadId})`,
    ),
    check(
      'profile_media_objects_lease_check',
      sql`num_nonnulls(${t.leaseId},${t.leasedUntil}) in (0,2)`,
    ),
    organizationPolicy('profile_media_objects_organization_isolation'),
  ],
);

/** Authenticated encrypted signing receipt and a recoverable exclusive signing lease. */
export const profileMediaReceipts = pgTable(
  'profile_media_receipts',
  {
    organizationId: uuid('organization_id'),
    ownerKind: text('owner_kind').notNull(),
    ownerId: uuid('owner_id').notNull(),
    uploadId: uuid('upload_id').notNull(),
    leaseId: uuid('lease_id'),
    leasedUntil: instant('leased_until'),
    keyId: text('key_id'),
    nonce: bytea('nonce'),
    ciphertext: bytea('ciphertext'),
    authTag: bytea('auth_tag'),
    receiptExpiresAt: instant('receipt_expires_at'),
  },
  (t) => [
    primaryKey({ columns: [t.ownerKind, t.ownerId, t.uploadId] }),
    foreignKey({
      columns: [t.ownerKind, t.ownerId, t.uploadId],
      foreignColumns: [
        profileMediaUploads.ownerKind,
        profileMediaUploads.ownerId,
        profileMediaUploads.uploadId,
      ],
      name: 'profile_media_receipts_upload_fk',
    }),
    index('profile_media_receipts_tenant_idx').on(
      t.organizationId,
      t.ownerKind,
      t.ownerId,
      t.uploadId,
    ),
    index('profile_media_receipts_expiry_idx')
      .on(t.receiptExpiresAt, t.ownerKind, t.ownerId, t.uploadId)
      .where(sql`${t.receiptExpiresAt} is not null`),
    check(
      'profile_media_receipts_scope_check',
      sql`(${t.ownerKind} = 'avatar' and ${t.organizationId} is null) or (${t.ownerKind} = 'organization-logo' and ${t.organizationId} is not null and ${t.organizationId} = ${t.ownerId})`,
    ),
    check(
      'profile_media_receipts_lease_check',
      sql`num_nonnulls(${t.leaseId},${t.leasedUntil}) in (0,2)`,
    ),
    check(
      'profile_media_receipts_sealed_check',
      sql`num_nonnulls(${t.keyId},${t.nonce},${t.ciphertext},${t.authTag},${t.receiptExpiresAt}) in (0,5)`,
    ),
    organizationPolicy('profile_media_receipts_organization_isolation'),
  ],
);
