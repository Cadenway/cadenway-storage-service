import type { TransactionScope } from '@cadenway/nest-common/database';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import type { ProfileMediaCleanupLease } from '../../../../../application/models/media/profile-media-cleanup-lease.model.js';
import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';
import {
  profileMediaObjects,
  profileMediaOwners,
  profileMediaReceipts,
  profileMediaUploads,
} from '../../schemas/media/profile-media.schema.js';

/** Removes expired encrypted capabilities in one indexed, non-blocking system batch. */
export async function deleteExpiredProfileMediaReceipts(
  scope: TransactionScope,
  limit: number,
): Promise<number> {
  if (scope.kind !== 'system' || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError('Invalid profile receipt cleanup scope or page.');
  }
  const result = await scope.db.execute(sql`
    with expired as (
      select owner_kind, owner_id, upload_id
      from ${profileMediaReceipts}
      where receipt_expires_at <= statement_timestamp()
      order by receipt_expires_at, owner_kind, owner_id, upload_id
      limit ${limit} for update skip locked
    )
    delete from ${profileMediaReceipts} as receipt
    using expired
    where (receipt.owner_kind, receipt.owner_id, receipt.upload_id)
      = (expired.owner_kind, expired.owner_id, expired.upload_id)
  `);
  return result.rowCount ?? 0;
}

/** Reclaims a single owner in the corresponding verified tenant or account transaction. */
export class DrizzleProfileMediaCleanupTransaction {
  // #region Constructor
  /** Rejects a system-scoped logo or an unrelated logo tenant. */
  public constructor(
    private readonly scope: TransactionScope,
    private readonly owner: ProfileMediaOwnerBinding,
  ) {
    if (
      owner.kind === 'avatar'
        ? scope.kind !== 'system'
        : scope.kind !== 'tenant' || scope.organizationId?.toLowerCase() !== owner.id.toLowerCase()
    )
      throw new Error('Invalid profile media cleanup scope.');
    this.owner = { kind: owner.kind, id: owner.id.toLowerCase() };
  }
  // #endregion

  // #region Methods
  /** Locks the owner then fences at most one page, preserving elected live media. */
  public async claim(limit: number): Promise<readonly ProfileMediaCleanupLease[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new RangeError('Invalid profile media cleanup page.');
    const [owner] = await this.scope.db
      .select({ deleted: profileMediaOwners.deleted })
      .from(profileMediaOwners)
      .where(this.ownerWhere())
      .for('update');
    if (owner === undefined) return [];
    const objects = profileMediaObjects;
    const rows = await this.scope.db
      .select({ uploadId: objects.uploadId, objectId: objects.objectId })
      .from(objects)
      .where(
        and(
          this.objectsWhere(),
          or(isNull(objects.leasedUntil), sql`${objects.leasedUntil} <= clock_timestamp()`),
          owner.deleted
            ? sql`(${objects.status} in ('active','fenced','elected') and (${objects.role} <> 'staging' or ${objects.cleanupAfter} <= clock_timestamp()))`
            : sql`${objects.status} in ('active','fenced') and ${objects.cleanupAfter} <= clock_timestamp()`,
        ),
      )
      .orderBy(asc(objects.cleanupAfter), asc(objects.uploadId), asc(objects.objectId))
      .limit(limit)
      .for('update');
    if (rows.length === 0) return [];
    const keys = sql.join(
      rows.map((row) => sql`(${row.uploadId}::uuid, ${row.objectId}::uuid)`),
      sql`, `,
    );
    const result = await this.scope.db.execute<{
      uploadId: string;
      objectId: string;
      generation: number;
      leaseId: string;
      retention: 'preserve' | 'candidate' | 'transient';
    }>(sql`
      update ${objects} set status = 'fenced', generation = ${objects.generation} + 1,
        lease_id = uuidv7(), leased_until = clock_timestamp() + interval '15 minutes'
      from (values ${keys}) as selected(upload_id, object_id)
      where ${this.objectsWhere()} and ${objects.uploadId} = selected.upload_id and ${objects.objectId} = selected.object_id
      returning ${objects.uploadId} as "uploadId", ${objects.objectId} as "objectId", ${objects.generation} as generation, ${objects.leaseId} as "leaseId",
        case when ${objects.role} = 'staging' then 'transient' else ${objects.retention} end as retention
    `);
    return result.rows.map((row) => ({ owner: this.owner, ...row }));
  }

  /** Settles only the exact lease generation after an external erasure. */
  public async complete(lease: ProfileMediaCleanupLease): Promise<void> {
    await this.settle([lease], true);
  }

  /** Releases a bounded page of exact leases for a later retry. */
  public async release(leases: readonly ProfileMediaCleanupLease[]): Promise<void> {
    await this.settle(leases, false);
  }

  /** Requeues previously cleaned physical keys observed in a later inventory pass. */
  public async requeueObserved(
    objects: readonly {
      readonly uploadId: string;
      readonly objectId: string;
      readonly role: 'staging' | 'candidate';
    }[],
  ): Promise<number> {
    if (objects.length === 0) return 0;
    if (objects.length > 500) throw new RangeError('Invalid profile inventory page.');
    const [owner] = await this.scope.db
      .select({ id: profileMediaOwners.ownerId })
      .from(profileMediaOwners)
      .where(this.ownerWhere())
      .for('update');
    if (owner === undefined) return 0;
    const table = profileMediaObjects;
    const keys = sql.join(
      objects.map(
        (object) => sql`(${object.uploadId}::uuid, ${object.objectId}::uuid, ${object.role}::text)`,
      ),
      sql`, `,
    );
    const result = await this.scope.db.execute(sql`
      update ${table} set status = 'fenced', cleanup_after = clock_timestamp(), generation = ${table.generation} + 1, lease_id = null, leased_until = null
      from (values ${keys}) as observed(upload_id, object_id, role)
      where ${this.objectsWhere()} and ${table.uploadId} = observed.upload_id and ${table.objectId} = observed.object_id and ${table.role} = observed.role and ${table.status} = 'cleaned'
    `);
    return result.rowCount ?? 0;
  }

  /** Removes one bounded page of encrypted receipts after an irreversible owner deletion. */
  public async purgeDeletedReceipts(limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new RangeError('Invalid profile receipt cleanup page.');
    const [owner] = await this.scope.db
      .select({ deleted: profileMediaOwners.deleted })
      .from(profileMediaOwners)
      .where(this.ownerWhere())
      .for('update');
    if (owner?.deleted !== true) return 0;
    const table = profileMediaReceipts;
    const scope = and(
      eq(table.ownerKind, this.owner.kind),
      eq(table.ownerId, this.owner.id),
      this.owner.kind === 'avatar'
        ? isNull(table.organizationId)
        : eq(table.organizationId, this.owner.id),
    );
    const rows = await this.scope.db
      .select({ uploadId: table.uploadId })
      .from(table)
      .where(scope)
      .orderBy(asc(table.uploadId))
      .limit(limit);
    if (rows.length === 0) return 0;
    const removed = await this.scope.db
      .delete(table)
      .where(
        and(
          scope,
          inArray(
            table.uploadId,
            rows.map((row) => row.uploadId),
          ),
        ),
      )
      .returning({ uploadId: table.uploadId });
    return removed.length;
  }

  /** Keeps only upload tombstones once a deleted account's receipts and objects are gone. */
  public async compactDeletedUploads(limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('Invalid profile upload compaction page.');
    }
    const [owner] = await this.scope.db
      .select({ deleted: profileMediaOwners.deleted })
      .from(profileMediaOwners)
      .where(this.ownerWhere())
      .for('update');
    if (owner?.deleted !== true) return 0;
    const result = await this.scope.db.execute(sql`
      with compactable as (
        select upload.upload_id
        from ${profileMediaUploads} as upload
        where upload.owner_kind = ${this.owner.kind} and upload.owner_id = ${this.owner.id}::uuid
          and (upload.uploader_user_id is not null or upload.candidate_id is not null)
          and not exists (
            select from ${profileMediaObjects} as object
            where (object.owner_kind, object.owner_id, object.upload_id)
              = (upload.owner_kind, upload.owner_id, upload.upload_id) and object.status <> 'cleaned'
          )
          and not exists (
            select from ${profileMediaReceipts} as receipt
            where (receipt.owner_kind, receipt.owner_id, receipt.upload_id)
              = (upload.owner_kind, upload.owner_id, upload.upload_id)
          )
        order by upload.upload_id
        limit ${limit}
      )
      update ${profileMediaUploads} as upload
      set status = 'retired', uploader_user_id = null, content_type = null, size_bytes = null,
          expires_at = null, candidate_id = null, width = null, height = null,
          derivative_size_bytes = null
      from compactable
      where upload.owner_kind = ${this.owner.kind} and upload.owner_id = ${this.owner.id}::uuid
        and upload.upload_id = compactable.upload_id
    `);
    return result.rowCount ?? 0;
  }

  /** Clears the deletion sweep marker after objects and receipts are gone and uploads compacted. */
  public async finishDeletedOwner(): Promise<boolean> {
    const [owner] = await this.scope.db
      .select({ deleted: profileMediaOwners.deleted })
      .from(profileMediaOwners)
      .where(this.ownerWhere())
      .for('update');
    if (owner?.deleted !== true) return false;
    const objects = profileMediaObjects;
    const receipts = profileMediaReceipts;
    const [remainingObject] = await this.scope.db
      .select({ objectId: objects.objectId })
      .from(objects)
      .where(and(this.objectsWhere(), sql`${objects.status} <> 'cleaned'`))
      .limit(1);
    if (remainingObject !== undefined) return false;
    const receiptScope = and(
      eq(receipts.ownerKind, this.owner.kind),
      eq(receipts.ownerId, this.owner.id),
      this.owner.kind === 'avatar'
        ? isNull(receipts.organizationId)
        : eq(receipts.organizationId, this.owner.id),
    );
    const [remainingReceipt] = await this.scope.db
      .select({ uploadId: receipts.uploadId })
      .from(receipts)
      .where(receiptScope)
      .limit(1);
    if (remainingReceipt !== undefined) return false;
    const [remainingUpload] = await this.scope.db
      .select({ uploadId: profileMediaUploads.uploadId })
      .from(profileMediaUploads)
      .where(
        and(
          eq(profileMediaUploads.ownerKind, this.owner.kind),
          eq(profileMediaUploads.ownerId, this.owner.id),
          or(
            isNotNull(profileMediaUploads.uploaderUserId),
            isNotNull(profileMediaUploads.candidateId),
          ),
        ),
      )
      .limit(1);
    if (remainingUpload !== undefined) return false;
    await this.scope.db
      .update(profileMediaOwners)
      .set({ cleanupRequested: false })
      .where(this.ownerWhere());
    return true;
  }

  private async settle(
    leases: readonly ProfileMediaCleanupLease[],
    erased: boolean,
  ): Promise<void> {
    if (leases.length === 0) return;
    if (leases.length > 500) throw new RangeError('Invalid profile media cleanup page.');
    if (
      leases.some(
        ({ owner }) => owner.kind !== this.owner.kind || owner.id.toLowerCase() !== this.owner.id,
      )
    )
      throw new Error('Profile cleanup owner mismatch.');
    const objects = profileMediaObjects;
    const keys = sql.join(
      leases.map(
        ({ uploadId, objectId, generation, leaseId }) =>
          sql`(${uploadId}::uuid, ${objectId}::uuid, ${generation}::integer, ${leaseId}::uuid)`,
      ),
      sql`, `,
    );
    const cleanupAfter = erased
      ? sql`${objects.cleanupAfter}`
      : sql`clock_timestamp() + interval '60 seconds'`;
    await this.scope.db.execute(sql`
      update ${objects}
      set status = ${erased ? 'cleaned' : 'fenced'}, lease_id = null, leased_until = null,
          generation = ${objects.generation} + 1, cleanup_after = ${cleanupAfter}
      from (values ${keys}) as settled(upload_id, object_id, generation, lease_id)
      where ${this.objectsWhere()} and ${objects.status} = 'fenced'
        and (${objects.uploadId}, ${objects.objectId}, ${objects.generation}, ${objects.leaseId})
          = (settled.upload_id, settled.object_id, settled.generation, settled.lease_id)
    `);
  }

  private ownerWhere() {
    return and(
      eq(profileMediaOwners.ownerKind, this.owner.kind),
      eq(profileMediaOwners.ownerId, this.owner.id),
      this.owner.kind === 'avatar'
        ? isNull(profileMediaOwners.organizationId)
        : eq(profileMediaOwners.organizationId, this.owner.id),
    );
  }

  private objectsWhere() {
    return and(
      eq(profileMediaObjects.ownerKind, this.owner.kind),
      eq(profileMediaObjects.ownerId, this.owner.id),
      this.owner.kind === 'avatar'
        ? isNull(profileMediaObjects.organizationId)
        : eq(profileMediaObjects.organizationId, this.owner.id),
    );
  }
  // #endregion
}
