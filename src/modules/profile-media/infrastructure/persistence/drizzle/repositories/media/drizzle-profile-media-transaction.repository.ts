import type { TransactionScope } from '@cadenway/nest-common/database';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { stagingTransferCleanupAfter } from '../../../../../../../infrastructure/object-storage/upload-transfer-ticket.js';
import type { ProfileMediaTransaction } from '../../../../../application/models/media/profile-media-transaction.model.js';
import type { ProfileMediaCapability } from '../../../../../application/models/media/profile-media-capability.model.js';
import type { ProfileMediaCandidateRetention } from '../../../../../application/models/media/profile-media-candidate-retention.model.js';
import { ProfileMediaOwner } from '../../../../../domain/aggregates/media/profile-media-owner.aggregate.js';
import { ProfileMediaUpload } from '../../../../../domain/aggregates/media/profile-media-upload.aggregate.js';
import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';
import {
  profileMediaObjects,
  profileMediaOwners,
  profileMediaReceipts,
  profileMediaUploads,
} from '../../schemas/media/profile-media.schema.js';

interface Sealed {
  // #region Properties
  /** Encryption metadata and authenticated ciphertext. */
  readonly keyId: string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
  // #endregion
}

/** Authenticated encryption binds the entire declaration and its retained expiry. */
export interface ProfileMediaReceiptCipher {
  // #region Methods
  /** Authenticates and seals the capability. */
  seal(capability: ProfileMediaCapability, binding: string): Sealed;

  /** Opens the capability under its original binding. */
  open(sealed: Sealed, binding: string): ProfileMediaCapability;
  // #endregion
}

/** Implements owner-scoped media writes inside an already verified transaction. */
export class DrizzleProfileMediaTransaction implements ProfileMediaTransaction {
  // #region Properties
  /** Tracks the required owner lock in this transaction. */
  private locked = false;
  // #endregion

  // #region Constructor
  /** Avatar transactions must be system-scoped; logos must match the current tenant. */
  public constructor(
    private readonly scope: TransactionScope,
    private readonly owner: ProfileMediaOwnerBinding,
    private readonly cipher: ProfileMediaReceiptCipher,
  ) {
    if (
      owner.kind === 'avatar'
        ? scope.kind !== 'system'
        : scope.kind !== 'tenant' || scope.organizationId?.toLowerCase() !== owner.id.toLowerCase()
    )
      throw new Error('Invalid profile media transaction scope.');
    this.owner = { kind: owner.kind, id: owner.id.toLowerCase() };
  }
  // #endregion

  // #region Methods
  /** Locks the durable owner row before access to any of its uploads. */
  public async lockOwner(owner: ProfileMediaOwnerBinding): Promise<ProfileMediaOwner> {
    this.check(owner, false);
    await this.scope.db
      .insert(profileMediaOwners)
      .values({ ...this.columns(), generation: 0 })
      .onConflictDoNothing();
    const [row] = await this.scope.db
      .select()
      .from(profileMediaOwners)
      .where(this.where(profileMediaOwners))
      .for('update');
    if (row === undefined) throw new Error('Profile owner lock unavailable.');
    this.locked = true;
    return ProfileMediaOwner.restore({
      owner: this.owner,
      generation: row.generation,
      assetId: row.assetId,
      deleted: row.deleted,
    });
  }

  /** Locks and reconstructs exactly one owner-bound reservation. */
  public async lockUpload(
    owner: ProfileMediaOwnerBinding,
    uploadId: string,
  ): Promise<ProfileMediaUpload | null> {
    this.check(owner);
    const [row] = await this.scope.db
      .select()
      .from(profileMediaUploads)
      .where(and(this.where(profileMediaUploads), eq(profileMediaUploads.uploadId, uploadId)))
      .for('update');
    if (row === undefined) return null;
    const declaration =
      row.uploaderUserId !== null &&
      row.contentType !== null &&
      row.sizeBytes !== null &&
      row.expiresAt !== null
        ? {
            uploaderUserId: row.uploaderUserId,
            contentType: row.contentType,
            sizeBytes: row.sizeBytes,
            expiresAt: row.expiresAt,
          }
        : null;
    const derivative =
      row.candidateId !== null &&
      row.width !== null &&
      row.height !== null &&
      row.derivativeSizeBytes !== null
        ? {
            candidateId: row.candidateId,
            contentType: 'image/png' as const,
            width: row.width,
            height: row.height,
            sizeBytes: row.derivativeSizeBytes,
          }
        : null;
    return ProfileMediaUpload.restore({
      owner: this.owner,
      uploadId: row.uploadId,
      status: row.status,
      declaration,
      derivative,
    });
  }

  /** Saves the initial declaration and records its staging object before signing. */
  public async insertUpload(upload: ProfileMediaUpload): Promise<void> {
    const state = upload.snapshot;
    this.check(state.owner);
    if (state.status !== 'pending') throw new Error('A reservation must be pending.');
    await this.scope.db.insert(profileMediaUploads).values(this.values(upload));
    await this.scope.db.insert(profileMediaObjects).values({
      ...this.columns(),
      uploadId: state.uploadId,
      objectId: state.uploadId,
      role: 'staging',
      status: 'active',
      retention: 'transient',
      cleanupAfter: state.declaration.expiresAt,
    });
  }

  /** Upserts the terminal fence, including an owner decision before reservation. */
  public async saveUpload(upload: ProfileMediaUpload): Promise<void> {
    const state = upload.snapshot;
    this.check(state.owner);
    const values = this.values(upload);
    await this.scope.db
      .insert(profileMediaUploads)
      .values(values)
      .onConflictDoUpdate({
        target: [
          profileMediaUploads.ownerKind,
          profileMediaUploads.ownerId,
          profileMediaUploads.uploadId,
        ],
        set: values,
      });
  }

  /** Updates only the locked owner watermark. */
  public async saveOwner(owner: ProfileMediaOwner): Promise<void> {
    const state = owner.snapshot;
    this.check(state.owner);
    await this.scope.db
      .update(profileMediaOwners)
      .set({ generation: state.generation, assetId: state.assetId, deleted: state.deleted })
      .where(this.where(profileMediaOwners));
  }

  /** Authenticates the sealed receipt with the exact current declaration. */
  public async findCapability(
    owner: ProfileMediaOwnerBinding,
    uploadId: string,
  ): Promise<ProfileMediaCapability | null> {
    const upload = await this.lockUpload(owner, uploadId);
    if (upload === null) return null;
    const [row] = await this.scope.db
      .select()
      .from(profileMediaReceipts)
      .where(
        and(
          this.where(profileMediaReceipts),
          eq(profileMediaReceipts.uploadId, uploadId),
          sql`${profileMediaReceipts.receiptExpiresAt} > statement_timestamp()`,
        ),
      );
    if (
      row === undefined ||
      row.keyId === null ||
      row.nonce === null ||
      row.ciphertext === null ||
      row.authTag === null ||
      row.receiptExpiresAt === null
    )
      return null;
    return this.cipher.open(
      { keyId: row.keyId, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.authTag },
      this.binding(upload, row.receiptExpiresAt),
    );
  }

  /** Serializes signing and expires abandoned leases. */
  public async claimSigning(
    owner: ProfileMediaOwnerBinding,
    uploadId: string,
  ): Promise<string | null> {
    this.check(owner);
    const [row] = await this.scope.db
      .insert(profileMediaReceipts)
      .values({
        ...this.columns(),
        uploadId,
        leaseId: sql`uuidv7()`,
        leasedUntil: sql`clock_timestamp() + interval '30 seconds'`,
      })
      .onConflictDoUpdate({
        target: [
          profileMediaReceipts.ownerKind,
          profileMediaReceipts.ownerId,
          profileMediaReceipts.uploadId,
        ],
        set: {
          leaseId: sql`uuidv7()`,
          leasedUntil: sql`clock_timestamp() + interval '30 seconds'`,
        },
        setWhere: sql`${profileMediaReceipts.ciphertext} is null and (${profileMediaReceipts.leasedUntil} is null or ${profileMediaReceipts.leasedUntil} <= clock_timestamp())`,
      })
      .returning({ leaseId: profileMediaReceipts.leaseId });
    return row?.leaseId ?? null;
  }

  /** Commits a sealed capability only to the same still-live lease. */
  public async completeSigning(
    owner: ProfileMediaOwnerBinding,
    uploadId: string,
    leaseId: string,
    capability: ProfileMediaCapability,
  ): Promise<boolean> {
    const upload = await this.lockUpload(owner, uploadId);
    if (upload === null) return false;
    const declaration = upload.snapshot.declaration;
    if (
      declaration === null ||
      capability.uploadId !== upload.snapshot.uploadId ||
      new Date(capability.expiresAt).getTime() !== declaration.expiresAt.getTime()
    )
      return false;
    const [time] = await this.scope.db
      .execute<{ expires: string }>(
        sql`select floor(extract(epoch from (clock_timestamp() + interval '24 hours')) * 1000)::text as expires`,
      )
      .then((result) => result.rows);
    if (time === undefined) throw new Error('Receipt retention unavailable.');
    const expiresAtMs = Number(time.expires);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
      throw new Error('Receipt retention unavailable.');
    }
    const receiptExpiresAt = new Date(expiresAtMs);
    const sealed = this.cipher.seal(capability, this.binding(upload, receiptExpiresAt));
    const rows = await this.scope.db
      .update(profileMediaReceipts)
      .set({ ...sealed, receiptExpiresAt, leaseId: null, leasedUntil: null })
      .where(
        and(
          this.where(profileMediaReceipts),
          eq(profileMediaReceipts.uploadId, uploadId),
          eq(profileMediaReceipts.leaseId, leaseId),
          sql`${profileMediaReceipts.leasedUntil} > clock_timestamp()`,
          isNull(profileMediaReceipts.ciphertext),
        ),
      )
      .returning({ uploadId: profileMediaReceipts.uploadId });
    if (rows.length === 1 && capability.fields.ticket !== undefined) {
      await this.scope.db
        .update(profileMediaObjects)
        .set({ cleanupAfter: stagingTransferCleanupAfter(declaration.expiresAt) })
        .where(
          and(
            this.where(profileMediaObjects),
            eq(profileMediaObjects.uploadId, uploadId),
            eq(profileMediaObjects.role, 'staging'),
            eq(profileMediaObjects.status, 'active'),
          ),
        );
    }
    return rows.length === 1;
  }

  /** Releases an abandoned signing attempt without affecting another lease. */
  public async releaseSigning(
    owner: ProfileMediaOwnerBinding,
    uploadId: string,
    leaseId: string,
  ): Promise<void> {
    this.check(owner);
    await this.scope.db
      .update(profileMediaReceipts)
      .set({ leaseId: null, leasedUntil: null })
      .where(
        and(
          this.where(profileMediaReceipts),
          eq(profileMediaReceipts.uploadId, uploadId),
          eq(profileMediaReceipts.leaseId, leaseId),
        ),
      );
  }

  /** Registers a candidate before external object creation. */
  public async registerCandidate(
    owner: ProfileMediaOwnerBinding,
    uploadId: string,
    candidateId: string,
    retention: ProfileMediaCandidateRetention,
  ): Promise<void> {
    if (candidateId.toLowerCase() === uploadId.toLowerCase())
      throw new Error('Candidate identity must differ from staging.');
    const upload = await this.lockUpload(owner, uploadId);
    if (upload?.snapshot.declaration === null || upload === null)
      throw new Error('Missing reservation.');
    await this.scope.db.insert(profileMediaObjects).values({
      ...this.columns(),
      uploadId,
      objectId: candidateId,
      role: 'candidate',
      status: 'active',
      retention,
      cleanupAfter: upload.snapshot.declaration.expiresAt,
    });
  }

  /** Elects exactly the registered candidate while the owner is locked. */
  public async electCandidate(upload: ProfileMediaUpload, candidateId: string): Promise<boolean> {
    const state = upload.snapshot;
    this.check(state.owner);
    if (state.status !== 'prepared' || state.derivative.candidateId !== candidateId) return false;
    const result = await this.scope.db
      .update(profileMediaObjects)
      .set({ status: 'elected', retention: 'preserve' })
      .where(
        and(
          this.where(profileMediaObjects),
          eq(profileMediaObjects.uploadId, state.uploadId),
          eq(profileMediaObjects.objectId, candidateId),
          eq(profileMediaObjects.role, 'candidate'),
          eq(profileMediaObjects.status, 'active'),
          inArray(profileMediaObjects.retention, ['candidate', 'preserve']),
        ),
      )
      .returning({ objectId: profileMediaObjects.objectId });
    if (result.length !== 1) return false;
    await this.scope.db
      .update(profileMediaObjects)
      .set({ status: 'fenced', generation: sql`${profileMediaObjects.generation} + 1` })
      .where(
        and(
          this.where(profileMediaObjects),
          eq(profileMediaObjects.uploadId, state.uploadId),
          eq(profileMediaObjects.role, 'candidate'),
          eq(profileMediaObjects.status, 'active'),
        ),
      );
    await this.saveUpload(upload);
    return true;
  }

  /** Reclaims a candidate whose election was definitively refused under the owner lock. */
  public async scheduleCandidateCleanup(
    owner: ProfileMediaOwnerBinding,
    uploadId: string,
    candidateId: string,
  ): Promise<void> {
    this.check(owner);
    await this.scope.db
      .update(profileMediaObjects)
      .set({
        status: 'fenced',
        retention: 'transient',
        cleanupAfter: sql`clock_timestamp()`,
        generation: sql`${profileMediaObjects.generation} + 1`,
        leaseId: null,
        leasedUntil: null,
      })
      .where(
        and(
          this.where(profileMediaObjects),
          eq(profileMediaObjects.uploadId, uploadId),
          eq(profileMediaObjects.objectId, candidateId),
          eq(profileMediaObjects.role, 'candidate'),
          eq(profileMediaObjects.retention, 'candidate'),
          inArray(profileMediaObjects.status, ['active', 'fenced', 'cleaned']),
        ),
      );
  }

  /** Cancels only unfinished signing, preserving the original sealed receipt until expiry. */
  public async scheduleCleanup(owner: ProfileMediaOwnerBinding, uploadId: string): Promise<void> {
    this.check(owner);
    await this.scope.db
      .update(profileMediaObjects)
      .set({
        status: 'fenced',
        cleanupAfter: sql`case when ${profileMediaObjects.role} = 'staging' then greatest(${profileMediaObjects.cleanupAfter}, clock_timestamp()) else clock_timestamp() end`,
        generation: sql`${profileMediaObjects.generation} + 1`,
        leaseId: null,
        leasedUntil: null,
      })
      .where(
        and(
          this.where(profileMediaObjects),
          eq(profileMediaObjects.uploadId, uploadId),
          sql`${profileMediaObjects.status} in ('active','elected','fenced')`,
        ),
      );
    await this.scope.db
      .delete(profileMediaReceipts)
      .where(
        and(
          this.where(profileMediaReceipts),
          eq(profileMediaReceipts.uploadId, uploadId),
          isNull(profileMediaReceipts.ciphertext),
        ),
      );
  }

  /** Makes deleted-owner objects due without scanning or loading an unbounded list. */
  public async scheduleOwnerCleanup(owner: ProfileMediaOwnerBinding): Promise<void> {
    this.check(owner);
    await this.scope.db
      .update(profileMediaOwners)
      .set({ cleanupRequested: true })
      .where(this.where(profileMediaOwners));
  }

  private check(owner: ProfileMediaOwnerBinding, requireLock = true): void {
    if (
      owner.kind !== this.owner.kind ||
      owner.id.toLowerCase() !== this.owner.id ||
      (requireLock && !this.locked)
    )
      throw new Error('Profile media owner mismatch or missing lock.');
  }

  private columns() {
    return {
      ownerKind: this.owner.kind,
      ownerId: this.owner.id,
      organizationId: this.owner.kind === 'organization-logo' ? this.owner.id : null,
    };
  }

  private where(
    table:
      | typeof profileMediaOwners
      | typeof profileMediaUploads
      | typeof profileMediaReceipts
      | typeof profileMediaObjects,
  ) {
    return and(
      eq(table.ownerKind, this.owner.kind),
      eq(table.ownerId, this.owner.id),
      this.owner.kind === 'avatar'
        ? isNull(table.organizationId)
        : eq(table.organizationId, this.owner.id),
    );
  }

  private values(upload: ProfileMediaUpload) {
    const state = upload.snapshot;
    const d = state.declaration;
    const p = state.derivative;
    return {
      ...this.columns(),
      uploadId: state.uploadId,
      status: state.status,
      uploaderUserId: d?.uploaderUserId ?? null,
      contentType: d?.contentType ?? null,
      sizeBytes: d?.sizeBytes ?? null,
      expiresAt: d?.expiresAt ?? null,
      candidateId: p?.candidateId ?? null,
      width: p?.width ?? null,
      height: p?.height ?? null,
      derivativeSizeBytes: p?.sizeBytes ?? null,
    };
  }

  private binding(upload: ProfileMediaUpload, expiry: Date): string {
    const state = upload.snapshot;
    if (state.declaration === null) throw new Error('Receipt declaration missing.');
    const d = state.declaration;
    return JSON.stringify([
      'profile-media-receipt-v1',
      this.owner.kind,
      this.owner.id,
      state.uploadId,
      d.uploaderUserId,
      d.contentType,
      d.sizeBytes,
      d.expiresAt.toISOString(),
      expiry.toISOString(),
    ]);
  }
  // #endregion
}
