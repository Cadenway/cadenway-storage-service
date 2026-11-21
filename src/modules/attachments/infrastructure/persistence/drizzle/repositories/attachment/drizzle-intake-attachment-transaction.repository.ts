import type { TransactionScope } from '@cadenway/nest-common/database';
import { createHash } from 'node:crypto';
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';

import type { IntakeAttachmentIdentity } from '../../../../../application/models/intake-attachment/intake-attachment-identity.model.js';
import type { IntakeAttachmentTransaction } from '../../../../../application/models/intake-attachment/intake-attachment-transaction.model.js';
import type { IntakeSigningClaim } from '../../../../../application/models/intake-attachment/intake-signing-claim.model.js';
import type { UploadCapability } from '../../../../../application/models/attachment/upload-capability.model.js';
import type { AttachmentFact } from '../../../../../domain/events/attachment/attachment-fact.event.js';
import { AttachmentError } from '../../../../../domain/errors/attachment/attachment.error.js';
import type { IntakeAttachmentVerified } from '../../../../../domain/events/intake-attachment/intake-attachment-verified.event.js';
import type { Attachment } from '../../../../../domain/aggregates/attachment/attachment.aggregate.js';
import { IntakeAttachment } from '../../../../../domain/aggregates/intake-attachment/intake-attachment.aggregate.js';
import { AttachmentObjectStorageError } from '../../../../../application/ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import type { UploadReceiptCodec } from '../../../../adapters/crypto/upload-receipt.codec.js';
import { attachmentCandidates } from '../../schemas/attachment/attachment-candidates.schema.js';
import { attachmentTaskTombstones } from '../../schemas/attachment/attachment-task-tombstones.schema.js';
import { attachments } from '../../schemas/attachment/attachments.schema.js';
import { intakeAttachmentCandidates } from '../../schemas/attachment/intake-attachment-candidates.schema.js';
import { intakeAttachmentUploadClaims } from '../../schemas/attachment/intake-attachment-upload-claims.schema.js';
import { intakeAttachments } from '../../schemas/attachment/intake-attachments.schema.js';
import { DrizzleStorageQuota } from './drizzle-storage-quota.repository.js';

type Row = typeof intakeAttachments.$inferSelect;
type VerificationWriter = (fact: IntakeAttachmentVerified) => Promise<void>;
type FileWriter = (fact: AttachmentFact) => Promise<void>;

function required<T>(value: T | null): T {
  if (value === null) throw new Error('Stored intake reservation is incomplete.');
  return value;
}

/** Encodes immutable declaration fields, excluding generated staging and lease timestamps. */
function fingerprint(attachment: IntakeAttachment): string {
  const state = attachment.snapshot;
  const reservation = state.reservation;
  if (reservation === null) throw new Error('An intake declaration is required for signing.');
  return createHash('sha256')
    .update(
      JSON.stringify([
        'intake-attachment-declaration-v1',
        state.organizationId,
        state.publicationId,
        state.id,
        reservation.fileName,
        reservation.contentType,
        reservation.sizeBytes,
        reservation.expiresAt.toISOString(),
      ]),
    )
    .digest('hex');
}

/** Restores the aggregate only after validating the persisted nullable reservation shape. */
function restore(row: Row): IntakeAttachment {
  const identity = {
    organizationId: row.organizationId,
    publicationId: row.publicationId,
    id: row.id,
  };
  const reservation =
    row.stagingObjectKey === null
      ? null
      : {
          ...identity,
          stagingObjectKey: row.stagingObjectKey,
          fileName: row.fileName,
          contentType: row.contentType,
          sizeBytes: row.sizeBytes,
          reservedAt: row.reservedAt,
          expiresAt: row.expiresAt,
          uploadExpiresAt: row.uploadExpiresAt,
        };
  if (
    reservation !== null &&
    (reservation.fileName === null ||
      reservation.contentType === null ||
      reservation.sizeBytes === null ||
      reservation.reservedAt === null ||
      reservation.expiresAt === null ||
      reservation.uploadExpiresAt === null)
  )
    throw new Error('Stored intake reservation is incomplete.');
  if (!['pending', 'verified', 'claimed', 'released'].includes(row.status))
    throw new Error('Stored intake reservation status is invalid.');
  return IntakeAttachment.rehydrate({
    ...identity,
    status: row.status as 'pending' | 'verified' | 'claimed' | 'released',
    reservation:
      reservation === null
        ? null
        : {
            ...reservation,
            fileName: required(reservation.fileName),
            contentType: required(reservation.contentType),
            sizeBytes: required(reservation.sizeBytes),
            reservedAt: required(reservation.reservedAt),
            expiresAt: required(reservation.expiresAt),
            uploadExpiresAt: required(reservation.uploadExpiresAt),
          },
    candidateKey: row.candidateKey,
    verifiedAt: row.verifiedAt,
    taskKey: row.taskKey,
    decidedAt: row.decidedAt,
  });
}

/** The anonymous reservation and every outbox write use the caller's tenant transaction. */
export class DrizzleIntakeAttachmentTransaction implements IntakeAttachmentTransaction {
  // #region Properties
  /** Canonical tenant bound to all reads and writes. */
  private readonly organizationId: string;

  /** Shared quota check bound to this transaction and organization. */
  private readonly quota: DrizzleStorageQuota;

  /** Allocations serialized in this transaction. */
  private readonly locked = new Set<string>();

  /** Task locks retain the purge state until this transaction finishes. */
  private readonly lockedTasks = new Map<string, boolean>();
  // #endregion

  // #region Constructor
  /** Binds a verified tenant transaction and its outbox writers. */
  public constructor(
    private readonly scope: TransactionScope,
    organizationId: string,
    private readonly writeVerified: VerificationWriter,
    private readonly writeFile: FileWriter,
    private readonly receipts: UploadReceiptCodec | undefined,
  ) {
    if (
      scope.kind !== 'tenant' ||
      scope.organizationId?.toLowerCase() !== organizationId.toLowerCase()
    )
      throw new Error('Intake attachment requires its tenant transaction.');
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

  /** Serializes even a missing allocation against release-before-start. */
  public async lock(identity: IntakeAttachmentIdentity): Promise<IntakeAttachment | null> {
    const key = this.key(identity);
    await this.scope.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    this.locked.add(key);
    return this.read(identity);
  }

  /** Preserves the first declaration and staging key across interrupted signing. */
  public async beginSigning(proposed: IntakeAttachment): Promise<IntakeSigningClaim> {
    if (this.receipts === undefined) throw new AttachmentObjectStorageError();
    const state = proposed.snapshot;
    const identity = {
      organizationId: state.organizationId,
      publicationId: state.publicationId,
      attachmentId: state.id,
    };
    this.requireLock(identity);
    let attachment = await this.read(identity);
    if (attachment?.snapshot.status === 'released' || attachment?.snapshot.status === 'claimed')
      return { kind: 'released' };
    if (attachment !== null) {
      if (state.reservation === null) throw new Error('An intake declaration is required.');
      try {
        attachment.requireReservation(state.reservation);
      } catch (error) {
        if (error instanceof AttachmentError && error.reason === 'reservation-conflict')
          return { kind: 'conflict' };
        throw error;
      }
    }
    if (attachment === null) {
      const reservation = state.reservation;
      if (state.status !== 'pending' || reservation === null)
        throw new Error('Expected a pending intake declaration.');
      await this.scope.db.insert(intakeAttachments).values({
        organizationId: this.organizationId,
        publicationId: state.publicationId,
        id: state.id,
        status: state.status,
        stagingObjectKey: reservation.stagingObjectKey,
        fileName: reservation.fileName,
        contentType: reservation.contentType,
        sizeBytes: reservation.sizeBytes,
        reservedAt: reservation.reservedAt,
        expiresAt: reservation.expiresAt,
        uploadExpiresAt: reservation.uploadExpiresAt,
      });
      await this.scope.db.insert(intakeAttachmentCandidates).values({
        organizationId: this.organizationId,
        publicationId: state.publicationId,
        attachmentId: state.id,
        objectKey: reservation.stagingObjectKey,
        status: 'staging',
        cleanupAfter: reservation.expiresAt,
      });
      attachment = proposed;
    }
    const digest = fingerprint(attachment);
    const existing = await this.readClaim(identity, digest);
    if (existing !== undefined) return existing;
    const [lease] = await this.scope.db
      .insert(intakeAttachmentUploadClaims)
      .values({
        organizationId: this.organizationId,
        publicationId: identity.publicationId,
        attachmentId: identity.attachmentId,
        fingerprint: digest,
        expiresAt: sql`statement_timestamp() + interval '30 seconds'`,
      })
      .onConflictDoUpdate({
        target: [
          intakeAttachmentUploadClaims.organizationId,
          intakeAttachmentUploadClaims.publicationId,
          intakeAttachmentUploadClaims.attachmentId,
        ],
        set: {
          claimId: sql`uuidv7()`,
          fingerprint: digest,
          expiresAt: sql`statement_timestamp() + interval '30 seconds'`,
          keyId: null,
          nonce: null,
          ciphertext: null,
          authTag: null,
        },
        setWhere: lte(intakeAttachmentUploadClaims.expiresAt, sql`statement_timestamp()`),
      })
      .returning({ claimId: intakeAttachmentUploadClaims.claimId });
    if (lease === undefined) throw new AttachmentObjectStorageError();
    return { kind: 'acquired', claimId: lease.claimId, attachment };
  }

  /** Seals a capability only while its exact signing lease still belongs to this caller. */
  public async completeSigning(
    identity: IntakeAttachmentIdentity,
    claimId: string,
    capability: UploadCapability,
  ): Promise<{ readonly kind: 'completed' } | IntakeSigningClaim> {
    this.requireLock(identity);
    if (this.receipts === undefined) throw new AttachmentObjectStorageError();
    const attachment = await this.read(identity);
    if (attachment?.snapshot.status === 'released' || attachment?.snapshot.status === 'claimed')
      return { kind: 'released' };
    if (attachment === null) throw new AttachmentObjectStorageError();
    const reservation = attachment.snapshot.reservation;
    const signedExpiry = new Date(capability.expiresAt);
    if (
      reservation === null ||
      !Number.isFinite(signedExpiry.getTime()) ||
      signedExpiry <= reservation.reservedAt ||
      signedExpiry > reservation.uploadExpiresAt
    )
      throw new AttachmentObjectStorageError();
    const digest = fingerprint(attachment);
    const { rows } = await this.scope.db.execute<{ readonly expires_at_ms: number }>(sql`
      select (extract(epoch from date_trunc('milliseconds', statement_timestamp()) + interval '24 hours') * 1000)::double precision as expires_at_ms
    `);
    const milliseconds = rows[0]?.expires_at_ms;
    if (milliseconds === undefined || !Number.isSafeInteger(milliseconds))
      throw new AttachmentObjectStorageError();
    const expiresAt = new Date(milliseconds);
    const sealed = this.receipts.seal(capability, this.receiptBinding(identity, digest, expiresAt));
    const updated = await this.scope.db
      .update(intakeAttachmentUploadClaims)
      .set({ expiresAt, ...sealed })
      .where(
        and(
          this.matchClaim(identity),
          eq(intakeAttachmentUploadClaims.claimId, claimId),
          eq(intakeAttachmentUploadClaims.fingerprint, digest),
          isNull(intakeAttachmentUploadClaims.keyId),
          gt(intakeAttachmentUploadClaims.expiresAt, sql`statement_timestamp()`),
        ),
      )
      .returning({ claimId: intakeAttachmentUploadClaims.claimId });
    if (updated.length === 1) {
      await this.scope.db
        .update(intakeAttachments)
        .set({ uploadExpiresAt: signedExpiry })
        .where(this.match(identity));
      return { kind: 'completed' };
    }
    return (await this.readClaim(identity, digest)) ?? { kind: 'in-progress' };
  }

  /** Releases only the caller's uncompleted lease. */
  public async releaseSigning(identity: IntakeAttachmentIdentity, claimId: string): Promise<void> {
    this.requireLock(identity);
    await this.scope.db
      .delete(intakeAttachmentUploadClaims)
      .where(
        and(
          this.matchClaim(identity),
          eq(intakeAttachmentUploadClaims.claimId, claimId),
          isNull(intakeAttachmentUploadClaims.keyId),
        ),
      );
  }

  /** Registers a distinct candidate before starting its object copy. */
  public async registerCandidate(
    identity: IntakeAttachmentIdentity,
    candidateKey: string,
    cleanupAfter: Date,
  ): Promise<void> {
    this.requireLock(identity);
    await this.scope.db.insert(intakeAttachmentCandidates).values({
      organizationId: this.organizationId,
      publicationId: identity.publicationId,
      attachmentId: identity.attachmentId,
      objectKey: candidateKey,
      status: 'active',
      cleanupAfter,
    });
  }

  /** Elects one unfenced candidate and appends its verification fact atomically. */
  public async electVerified(
    identity: IntakeAttachmentIdentity,
    attachment: IntakeAttachment,
    candidateKey: string,
    fact: IntakeAttachmentVerified,
  ): Promise<boolean> {
    this.requireLock(identity);
    const state = attachment.snapshot;
    if (
      state.organizationId !== this.organizationId ||
      state.publicationId !== identity.publicationId.toLowerCase() ||
      state.id !== identity.attachmentId.toLowerCase() ||
      state.status !== 'verified' ||
      state.candidateKey !== candidateKey ||
      fact.organizationId !== this.organizationId ||
      fact.publicationId !== identity.publicationId.toLowerCase() ||
      fact.attachmentId !== identity.attachmentId.toLowerCase()
    )
      throw new Error('Intake verification binding mismatch.');
    const elected = await this.scope.db
      .update(intakeAttachmentCandidates)
      .set({ status: 'elected' })
      .where(
        and(
          this.matchCandidate(identity),
          eq(intakeAttachmentCandidates.objectKey, candidateKey),
          eq(intakeAttachmentCandidates.status, 'active'),
        ),
      )
      .returning({ objectKey: intakeAttachmentCandidates.objectKey });
    if (elected.length === 0) return false;
    const updated = await this.scope.db
      .update(intakeAttachments)
      .set({ status: 'verified', candidateKey, verifiedAt: state.verifiedAt })
      .where(and(this.match(identity), eq(intakeAttachments.status, 'pending')))
      .returning({ id: intakeAttachments.id });
    if (updated.length !== 1) throw new Error('Intake verification lost its reservation.');
    await this.writeVerified(fact);
    return true;
  }

  /** Shares the task lock and permanent purge fence with ordinary attachments. */
  public async lockTask(taskKey: string): Promise<boolean> {
    if (this.locked.size > 0) throw new Error('Task lock must precede intake attachment locks.');
    await this.scope.db
      .insert(attachmentTaskTombstones)
      .values({ organizationId: this.organizationId, taskKey })
      .onConflictDoNothing();
    const [row] = await this.scope.db
      .select({ purgedAt: attachmentTaskTombstones.purgedAt })
      .from(attachmentTaskTombstones)
      .where(
        and(
          eq(attachmentTaskTombstones.organizationId, this.organizationId),
          eq(attachmentTaskTombstones.taskKey, taskKey),
        ),
      )
      .for('update');
    if (row === undefined) throw new Error('Task lock was not retained.');
    const purged = row.purgedAt !== null;
    this.lockedTasks.set(taskKey, purged);
    return purged;
  }

  /** Commits the terminal Task decision and any claimed attachment in this transaction. */
  public async saveDecision(
    identity: IntakeAttachmentIdentity,
    intake: IntakeAttachment,
    attachment: Attachment | null,
    fact: AttachmentFact | null,
  ): Promise<void> {
    this.requireLock(identity);
    const state = intake.snapshot;
    if (
      state.organizationId !== this.organizationId ||
      state.publicationId !== identity.publicationId.toLowerCase() ||
      state.id !== identity.attachmentId.toLowerCase() ||
      (state.status !== 'claimed' && state.status !== 'released')
    )
      throw new Error('Intake decision binding mismatch.');
    if ((attachment === null) !== (fact === null))
      throw new Error('Intake file fact does not match metadata.');
    if (attachment !== null && state.status !== 'claimed')
      throw new Error('Only claims may commit an attachment.');
    if (
      state.status === 'claimed' &&
      (state.taskKey === null || !this.lockedTasks.has(state.taskKey))
    )
      throw new Error('Intake claim requires the task lock.');
    if (
      attachment !== null &&
      (state.taskKey === null || this.lockedTasks.get(state.taskKey) !== false)
    )
      throw new Error('A purged task cannot receive an attachment.');
    const current = await this.read(identity);
    if (current === null) {
      if (attachment !== null || state.reservation !== null)
        throw new Error('Missing intake reservation for file.');
      await this.scope.db.insert(intakeAttachments).values({
        organizationId: this.organizationId,
        publicationId: state.publicationId,
        id: state.id,
        status: state.status,
        taskKey: state.taskKey,
        decidedAt: state.decidedAt,
      });
      await this.scope.db.delete(intakeAttachmentUploadClaims).where(this.matchClaim(identity));
      return;
    }
    await this.scope.db
      .update(intakeAttachments)
      .set({
        status: state.status,
        taskKey: state.taskKey,
        decidedAt: state.decidedAt,
        stagingObjectKey: null,
        fileName: null,
        contentType: null,
        sizeBytes: null,
        reservedAt: null,
        expiresAt: null,
        uploadExpiresAt: null,
        candidateKey: null,
        verifiedAt: null,
      })
      .where(this.match(identity));
    await this.scope.db.delete(intakeAttachmentUploadClaims).where(this.matchClaim(identity));
    if (attachment === null) {
      await this.scope.db
        .update(intakeAttachmentCandidates)
        .set({ status: 'fenced', cleanupAfter: sql`clock_timestamp()` })
        .where(
          and(this.matchCandidate(identity), eq(intakeAttachmentCandidates.status, 'elected')),
        );
    }
    if (attachment !== null && fact !== null) {
      const file = attachment.snapshot;
      if (
        file.organizationId !== this.organizationId ||
        file.id !== identity.attachmentId.toLowerCase() ||
        file.authorUserId !== null ||
        file.taskKey !== state.taskKey ||
        state.candidateKey === null
      )
        throw new Error('Claimed attachment binding mismatch.');
      await this.scope.db.insert(attachments).values({
        ...file,
        authorUserId: file.authorUserId,
        scanStatus: 'verified',
        electedObjectKey: state.candidateKey,
      });
      await this.scope.db.insert(attachmentCandidates).values({
        organizationId: this.organizationId,
        attachmentId: file.id,
        objectKey: state.candidateKey,
        status: 'elected',
        cleanupAfter: file.expiresAt,
      });
      await this.writeFile(fact);
    }
  }

  /** Canonical scope keys are always checked before database work. */
  private key(identity: IntakeAttachmentIdentity): string {
    if (identity.organizationId.toLowerCase() !== this.organizationId)
      throw new Error('Intake attachment tenant mismatch.');
    return [
      'intake-attachment',
      this.organizationId,
      identity.publicationId.toLowerCase(),
      identity.attachmentId.toLowerCase(),
    ].join(':');
  }

  private requireLock(identity: IntakeAttachmentIdentity): void {
    if (!this.locked.has(this.key(identity))) throw new Error('Intake attachment must be locked.');
  }

  private match(identity: IntakeAttachmentIdentity) {
    return and(
      eq(intakeAttachments.organizationId, this.organizationId),
      eq(intakeAttachments.publicationId, identity.publicationId),
      eq(intakeAttachments.id, identity.attachmentId),
    );
  }

  private matchCandidate(identity: IntakeAttachmentIdentity) {
    return and(
      eq(intakeAttachmentCandidates.organizationId, this.organizationId),
      eq(intakeAttachmentCandidates.publicationId, identity.publicationId),
      eq(intakeAttachmentCandidates.attachmentId, identity.attachmentId),
    );
  }

  private matchClaim(identity: IntakeAttachmentIdentity) {
    return and(
      eq(intakeAttachmentUploadClaims.organizationId, this.organizationId),
      eq(intakeAttachmentUploadClaims.publicationId, identity.publicationId),
      eq(intakeAttachmentUploadClaims.attachmentId, identity.attachmentId),
    );
  }

  private async read(identity: IntakeAttachmentIdentity): Promise<IntakeAttachment | null> {
    const [row] = await this.scope.db
      .select()
      .from(intakeAttachments)
      .where(this.match(identity))
      .for('update');
    return row === undefined ? null : restore(row);
  }

  /** Domain-separated use of the existing authenticated receipt codec. */
  private receiptBinding(identity: IntakeAttachmentIdentity, digest: string, expiresAt: Date) {
    return {
      organizationId: this.organizationId,
      actorId: identity.attachmentId.toLowerCase(),
      taskKey: 'intake:' + identity.publicationId.toLowerCase(),
      keyDigest: createHash('sha256').update(this.key(identity)).digest('hex'),
      fingerprint: digest,
      expiresAt,
    };
  }

  private async readClaim(
    identity: IntakeAttachmentIdentity,
    digest: string,
  ): Promise<IntakeSigningClaim | undefined> {
    const [row] = await this.scope.db
      .select()
      .from(intakeAttachmentUploadClaims)
      .where(
        and(
          this.matchClaim(identity),
          gt(intakeAttachmentUploadClaims.expiresAt, sql`statement_timestamp()`),
        ),
      );
    if (row === undefined) return undefined;
    if (row.fingerprint !== digest) return { kind: 'conflict' };
    if (row.keyId === null) return { kind: 'in-progress' };
    if (
      this.receipts === undefined ||
      row.nonce === null ||
      row.ciphertext === null ||
      row.authTag === null
    )
      throw new AttachmentObjectStorageError();
    return {
      kind: 'replay',
      capability: this.receipts.open(
        { keyId: row.keyId, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.authTag },
        this.receiptBinding(identity, digest, row.expiresAt),
      ),
    };
  }
  // #endregion
}
