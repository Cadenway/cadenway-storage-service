import type { TransactionScope } from '@cadenway/nest-common/database';
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import type { AttachmentActor } from '../../../../../application/models/attachment/attachment-actor.model.js';
import type { AttachmentTransaction } from '../../../../../application/models/attachment/attachment-transaction.model.js';
import type { UploadCapability } from '../../../../../application/models/attachment/upload-capability.model.js';
import type { UploadClaimConflict } from '../../../../../application/models/attachment/upload-claim-conflict.model.js';
import { Attachment } from '../../../../../domain/aggregates/attachment/attachment.aggregate.js';
import type { AttachmentFact } from '../../../../../domain/events/attachment/attachment-fact.event.js';
import type { UploadReceiptCodec } from '../../../../adapters/crypto/upload-receipt.codec.js';
import { AttachmentObjectStorageError } from '../../../../../application/ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import { attachmentCandidates } from '../../schemas/attachment/attachment-candidates.schema.js';
import { attachmentTaskTombstones } from '../../schemas/attachment/attachment-task-tombstones.schema.js';
import { attachmentUploadClaims } from '../../schemas/attachment/attachment-upload-claims.schema.js';
import { attachments } from '../../schemas/attachment/attachments.schema.js';
import { DrizzleStorageQuota } from './drizzle-storage-quota.repository.js';

type FactWriter = (fact: AttachmentFact, actor: AttachmentActor) => Promise<void>;
type UploadClaimScope = Pick<
  typeof attachmentUploadClaims.$inferSelect,
  'organizationId' | 'actorId' | 'taskKey' | 'keyDigest'
>;

/** Matches one tenant, actor, task and digested client key. */
function matchingUploadClaim(scope: UploadClaimScope): SQL | undefined {
  return and(
    eq(attachmentUploadClaims.organizationId, scope.organizationId),
    eq(attachmentUploadClaims.actorId, scope.actorId),
    eq(attachmentUploadClaims.taskKey, scope.taskKey),
    eq(attachmentUploadClaims.keyDigest, scope.keyDigest),
  );
}

/** Executes attachment lifecycle operations inside the caller's tenant transaction. */
export class DrizzleAttachmentTransaction implements AttachmentTransaction {
  // #region Properties
  /** Canonical organization ID used for locks and every query. */
  private readonly organizationId: string;

  /** Shared quota check bound to this transaction and organization. */
  private readonly quota: DrizzleStorageQuota;
  // #endregion

  // #region Constructor
  /** Receives the active transaction, its outbox-bound writer and the receipt codec. */
  public constructor(
    private readonly scope: TransactionScope,
    organizationId: string,
    private readonly writeFact: FactWriter,
    private readonly receipts: UploadReceiptCodec | undefined,
  ) {
    if (
      scope.kind !== 'tenant' ||
      scope.organizationId?.toLowerCase() !== organizationId.toLowerCase()
    ) {
      throw new Error('Attachment transaction requires its tenant scope.');
    }
    this.organizationId = organizationId.toLowerCase();
    this.quota = new DrizzleStorageQuota(scope, this.organizationId);
  }
  // #endregion

  // #region Methods
  /** Locks quota admission and reads the current tenant usage in a subsequent statement. */
  public async lockAndReadVerifiedBytes(): Promise<bigint> {
    await this.quota.lock();
    return this.quota.usedBytes();
  }

  /** Creates a lockable row even for tasks with no prior attachments. */
  public async lockTask(taskKey: string): Promise<boolean> {
    const { db } = this.scope;
    await db
      .insert(attachmentTaskTombstones)
      .values({ organizationId: this.organizationId, taskKey })
      .onConflictDoNothing();
    const rows = await db
      .select()
      .from(attachmentTaskTombstones)
      .where(
        and(
          eq(attachmentTaskTombstones.organizationId, this.organizationId),
          eq(attachmentTaskTombstones.taskKey, taskKey),
        ),
      )
      .for('update');
    if (rows.length !== 1) throw new Error('Task lock was not retained.');
    return rows[0]?.purgedAt !== null;
  }

  /** Records permanent revocation and durable bounded-cleanup work under the task lock. */
  public async registerTaskPurge(taskKey: string, actor: AttachmentActor): Promise<void> {
    await this.scope.db
      .update(attachmentTaskTombstones)
      .set({
        purgedAt: sql`now()`,
        purgeActorType: actor.type,
        purgeActorId: actor.id,
        cleanupPending: true,
      })
      .where(
        and(
          eq(attachmentTaskTombstones.organizationId, this.organizationId),
          eq(attachmentTaskTombstones.taskKey, taskKey),
          sql`${attachmentTaskTombstones.purgedAt} is null`,
        ),
      );
  }

  /** Restores a locked aggregate within the verified task and tenant. */
  public async lockAttachment(
    taskKey: string,
    attachmentId: string,
    electedObjectKey?: string,
  ): Promise<Attachment | null> {
    const rows = await this.scope.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.organizationId, this.organizationId),
          eq(attachments.taskKey, taskKey),
          eq(attachments.id, attachmentId),
        ),
      )
      .for('update');
    const row = rows[0];
    if (row === undefined) return null;
    if (electedObjectKey !== undefined && row.electedObjectKey !== electedObjectKey) return null;
    if (row.status !== 'pending' && row.status !== 'ready' && row.status !== 'deleted') {
      throw new Error('Stored attachment status is invalid.');
    }
    return Attachment.rehydrate({ ...row, status: row.status });
  }

  /** Persists the reservation and its future staging cleanup atomically. */
  public async insertReservation(attachment: Attachment): Promise<void> {
    const state = attachment.snapshot;
    if (state.organizationId !== this.organizationId.toLowerCase())
      throw new Error('Attachment tenant mismatch.');
    await this.scope.db.insert(attachments).values(state);
    await this.scope.db.insert(attachmentCandidates).values({
      organizationId: this.organizationId,
      attachmentId: state.id,
      objectKey: state.stagingObjectKey,
      status: 'staging',
      cleanupAfter: state.expiresAt,
    });
  }

  /** Commits one bounded pending lease while holding the task lock. */
  public async claimUpload(
    actorId: string,
    taskKey: string,
    key: string,
    fingerprint: string,
  ): Promise<{ readonly kind: 'acquired'; readonly claimId: string } | UploadClaimConflict> {
    if (this.receipts === undefined) throw new AttachmentObjectStorageError();
    const scope = this.uploadClaimScope(actorId, taskKey, key);
    const existing = await this.readActiveUploadClaim(scope, fingerprint);
    if (existing !== undefined) return existing;

    const expiresAt = sql`statement_timestamp() + interval '30 seconds'`;
    const [lease] = await this.scope.db
      .insert(attachmentUploadClaims)
      .values({ ...scope, fingerprint, expiresAt })
      .onConflictDoUpdate({
        target: [
          attachmentUploadClaims.organizationId,
          attachmentUploadClaims.actorId,
          attachmentUploadClaims.taskKey,
          attachmentUploadClaims.keyDigest,
        ],
        set: {
          claimId: sql`uuidv7()`,
          fingerprint,
          expiresAt,
          keyId: null,
          nonce: null,
          ciphertext: null,
          authTag: null,
        },
        setWhere: lte(attachmentUploadClaims.expiresAt, sql`statement_timestamp()`),
      })
      .returning({ claimId: attachmentUploadClaims.claimId });
    if (lease === undefined) throw new AttachmentObjectStorageError();
    return { kind: 'acquired', claimId: lease.claimId };
  }

  /** Turns a still-owned pending lease into an authenticated 24-hour receipt. */
  public async completeUploadClaim(
    actorId: string,
    taskKey: string,
    key: string,
    fingerprint: string,
    claimId: string,
    response: UploadCapability,
  ): Promise<{ readonly kind: 'completed' } | UploadClaimConflict> {
    if (this.receipts === undefined) throw new AttachmentObjectStorageError();
    // Drizzle returns raw timestamps as text. Bind the exact millisecond instant instead.
    const { rows } = await this.scope.db.execute<{ readonly expires_at_ms: number }>(sql`
      select (extract(epoch from date_trunc('milliseconds', statement_timestamp()) + interval '24 hours')
              * 1000)::double precision as expires_at_ms
    `);
    const expiresAtMs = rows[0]?.expires_at_ms;
    if (expiresAtMs === undefined || !Number.isSafeInteger(expiresAtMs))
      throw new AttachmentObjectStorageError();
    const expiresAt = new Date(expiresAtMs);
    const scope = this.uploadClaimScope(actorId, taskKey, key);
    const binding = { ...scope, fingerprint, expiresAt };
    const sealed = this.receipts.seal(response, binding);
    const persisted = await this.scope.db
      .update(attachmentUploadClaims)
      .set({ expiresAt, ...sealed })
      .where(
        and(
          matchingUploadClaim(scope),
          eq(attachmentUploadClaims.fingerprint, fingerprint),
          eq(attachmentUploadClaims.claimId, claimId),
          isNull(attachmentUploadClaims.keyId),
          gt(attachmentUploadClaims.expiresAt, sql`statement_timestamp()`),
        ),
      )
      .returning({ keyDigest: attachmentUploadClaims.keyDigest });
    if (persisted.length === 1) return { kind: 'completed' };
    const existing = await this.readActiveUploadClaim(scope, fingerprint);
    if (existing === undefined) throw new AttachmentObjectStorageError();
    return existing;
  }

  /** Removes a failed caller's lease under the task lock without affecting its replacement. */
  public async releaseUploadClaim(
    actorId: string,
    taskKey: string,
    key: string,
    claimId: string,
  ): Promise<void> {
    await this.scope.db
      .delete(attachmentUploadClaims)
      .where(
        and(
          matchingUploadClaim(this.uploadClaimScope(actorId, taskKey, key)),
          eq(attachmentUploadClaims.claimId, claimId),
          isNull(attachmentUploadClaims.keyId),
        ),
      );
  }

  /** Normalizes the same scoped key for acquisition, completion and release. */
  private uploadClaimScope(actorId: string, taskKey: string, key: string): UploadClaimScope {
    return {
      organizationId: this.organizationId,
      actorId: actorId.toLowerCase(),
      taskKey,
      keyDigest: createHash('sha256').update(key).digest('hex'),
    };
  }

  /** Resolves a current lease or verifies the stored response before replay. */
  private async readActiveUploadClaim(
    scope: UploadClaimScope,
    fingerprint: string,
  ): Promise<UploadClaimConflict | undefined> {
    const [row] = await this.scope.db
      .select()
      .from(attachmentUploadClaims)
      .where(
        and(
          matchingUploadClaim(scope),
          gt(attachmentUploadClaims.expiresAt, sql`statement_timestamp()`),
        ),
      );
    if (row === undefined) return undefined;
    if (row.fingerprint !== fingerprint) return { kind: 'key-reused' };
    if (row.keyId === null) return { kind: 'in-progress' };
    if (
      this.receipts === undefined ||
      row.nonce === null ||
      row.ciphertext === null ||
      row.authTag === null
    )
      throw new AttachmentObjectStorageError();
    const { keyId, nonce, ciphertext, authTag } = row;
    return {
      kind: 'replay',
      response: this.receipts.open({ keyId, nonce, ciphertext, authTag }, row),
    };
  }

  /** Registers one distinct immutable destination before copying bytes. */
  public async registerCandidate(
    attachmentId: string,
    candidateKey: string,
    cleanupAfter: Date,
  ): Promise<void> {
    await this.scope.db.insert(attachmentCandidates).values({
      organizationId: this.organizationId,
      attachmentId,
      objectKey: candidateKey,
      cleanupAfter,
      status: 'active',
    });
  }

  /** Elects only an active candidate of the locked pending attachment. */
  public async electCandidate(attachment: Attachment, candidateKey: string): Promise<boolean> {
    const state = attachment.snapshot;
    const candidate = await this.scope.db
      .update(attachmentCandidates)
      .set({ status: 'elected' })
      .where(
        and(
          eq(attachmentCandidates.organizationId, this.organizationId),
          eq(attachmentCandidates.attachmentId, state.id),
          eq(attachmentCandidates.objectKey, candidateKey),
          eq(attachmentCandidates.status, 'active'),
        ),
      )
      .returning({ objectKey: attachmentCandidates.objectKey });
    if (candidate.length !== 1) return false;
    const updated = await this.scope.db
      .update(attachments)
      .set({
        status: state.status,
        version: state.version,
        uploadedAt: state.uploadedAt,
        scanStatus: 'verified',
        electedObjectKey: candidateKey,
      })
      .where(
        and(
          eq(attachments.organizationId, this.organizationId),
          eq(attachments.id, state.id),
          eq(attachments.taskKey, state.taskKey),
          eq(attachments.status, 'pending'),
        ),
      )
      .returning({ id: attachments.id });
    if (updated.length !== 1) throw new Error('Candidate election lost its locked reservation.');
    return true;
  }

  /** Tombstones metadata and fences the elected object for eventual cleanup. */
  public async deleteAttachment(attachment: Attachment): Promise<void> {
    const state = attachment.snapshot;
    const previousStatus = state.uploadedAt === null ? 'pending' : 'ready';
    const updated = await this.scope.db
      .update(attachments)
      .set({
        status: state.status,
        version: state.version,
        deletedAt: state.deletedAt,
      })
      .where(
        and(
          eq(attachments.organizationId, this.organizationId),
          eq(attachments.id, state.id),
          eq(attachments.taskKey, state.taskKey),
          eq(attachments.status, previousStatus),
        ),
      )
      .returning({ electedObjectKey: attachments.electedObjectKey });
    if (updated.length !== 1) throw new Error('Locked attachment disappeared during deletion.');
    if (previousStatus === 'pending') return;
    const key = updated[0]?.electedObjectKey;
    if (key === null || key === undefined)
      throw new Error('Ready attachment disappeared during deletion.');
    const fenced = await this.scope.db
      .update(attachmentCandidates)
      .set({ status: 'fenced', cleanupAfter: sql`now()` })
      .where(
        and(
          eq(attachmentCandidates.organizationId, this.organizationId),
          eq(attachmentCandidates.attachmentId, state.id),
          eq(attachmentCandidates.objectKey, key),
          eq(attachmentCandidates.status, 'elected'),
        ),
      )
      .returning({ objectKey: attachmentCandidates.objectKey });
    if (fenced.length !== 1) throw new Error('Elected attachment object was not fenced.');
  }

  /** Appends through the outbox writer bound by the composition root. */
  public appendFact(fact: AttachmentFact, actor: AttachmentActor): Promise<void> {
    if (fact.organizationId !== this.organizationId.toLowerCase())
      throw new Error('Attachment fact tenant mismatch.');
    return this.writeFact(fact, actor);
  }
  // #endregion
}
