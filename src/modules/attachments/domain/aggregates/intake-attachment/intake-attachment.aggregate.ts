import { Attachment } from '../attachment/attachment.aggregate.js';
import { AttachmentError } from '../../errors/attachment/attachment.error.js';
import type { AttachmentFact } from '../../events/attachment/attachment-fact.event.js';
import type { IntakeAttachmentVerified } from '../../events/intake-attachment/intake-attachment-verified.event.js';
import {
  checkedAttachmentMediaType,
  requireAttachmentExtensionMediaType,
  requireAttachmentVerification,
} from '../../policies/attachment/attachment-file.policy.js';
import type { AttachmentVerification } from '../../value-objects/attachment/attachment-verification.value-object.js';
import type { IntakeAttachmentIdentity } from '../../value-objects/intake-attachment/intake-attachment-identity.value-object.js';
import type { IntakeAttachmentReservation } from '../../value-objects/intake-attachment/intake-attachment-reservation.value-object.js';
import type { IntakeAttachmentSnapshot } from '../../value-objects/intake-attachment/intake-attachment-snapshot.value-object.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TASK_KEY = /^[A-Z]{2,5}-[1-9][0-9]{0,8}$/u;
const MAX_SIGNED_UPLOAD_AGE_MS = 5 * 60 * 1_000;
const STAGING_PREFIX = 'intake/';

type Declaration = Omit<
  IntakeAttachmentReservation,
  'stagingObjectKey' | 'reservedAt' | 'uploadExpiresAt'
>;
type AllocatedReservation = NonNullable<IntakeAttachmentSnapshot['reservation']>;

interface IntakeVerificationChange {
  // #region Properties
  /** Resulting aggregate, or the original when the same acknowledgement is replayed. */
  readonly intakeAttachment: IntakeAttachment;

  /** Fact to append with the elected object in the verification transaction. */
  readonly event: IntakeAttachmentVerified | null;
  // #endregion
}

interface IntakeClaimChange {
  // #region Properties
  /** Aggregate with the terminal disposition of the candidate. */
  readonly intakeAttachment: IntakeAttachment;

  /** Ready attachment to persist only on the first claim for a task without a purge tombstone. */
  readonly attachment: Attachment | null;

  /** Ready-file fact to append with the attachment. */
  readonly event: AttachmentFact | null;
  // #endregion
}

function checkedTime(date: Date): number {
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) throw new AttachmentError('invalid-state');
  return milliseconds;
}

/** Canonicalizes the exact UUID binding from the internal Storage intake contracts. */
function checkedIdentity(input: IntakeAttachmentIdentity): IntakeAttachmentIdentity {
  const organizationId = input.organizationId.toLowerCase();
  const publicationId = input.publicationId.toLowerCase();
  const id = input.id.toLowerCase();
  if (!UUID.test(organizationId) || !UUID_V7.test(publicationId) || !UUID_V7.test(id)) {
    throw new AttachmentError('invalid-identity');
  }
  return { organizationId, publicationId, id };
}

function requireSameIdentity(
  left: IntakeAttachmentIdentity,
  right: IntakeAttachmentIdentity,
): void {
  if (
    left.organizationId !== right.organizationId ||
    left.publicationId !== right.publicationId ||
    left.id !== right.id
  ) {
    throw new AttachmentError('invalid-identity');
  }
}

/** Enforces the opaque staging path and bounded POST capability from startIntakeAttachmentUploadInternal. */
function checkedReservation(input: IntakeAttachmentReservation): AllocatedReservation {
  const identity = checkedIdentity(input);
  const stagingId = input.stagingObjectKey.slice(STAGING_PREFIX.length);
  if (
    !input.stagingObjectKey.startsWith(STAGING_PREFIX) ||
    !UUID_V7.test(stagingId) ||
    stagingId === identity.organizationId ||
    stagingId === identity.publicationId ||
    stagingId === identity.id
  ) {
    throw new AttachmentError('invalid-object-key');
  }
  const reservedAt = checkedTime(input.reservedAt);
  const expiresAt = checkedTime(input.expiresAt);
  const uploadLimit = Math.min(reservedAt + MAX_SIGNED_UPLOAD_AGE_MS, expiresAt);
  const uploadExpiresAt =
    input.uploadExpiresAt === undefined ? uploadLimit : checkedTime(input.uploadExpiresAt);
  if (uploadExpiresAt <= reservedAt || uploadExpiresAt > uploadLimit) {
    throw new AttachmentError('invalid-state');
  }
  return {
    ...identity,
    fileName: input.fileName,
    contentType: checkedAttachmentMediaType(input.fileName, input.contentType, input.sizeBytes),
    sizeBytes: input.sizeBytes,
    stagingObjectKey: input.stagingObjectKey,
    reservedAt: new Date(reservedAt),
    expiresAt: new Date(expiresAt),
    uploadExpiresAt: new Date(uploadExpiresAt),
  };
}

/** Keeps the verified copy in the tenant's private namespace, away from the signed staging path. */
function requireCandidateKey(candidateKey: string, identity: IntakeAttachmentIdentity): void {
  const prefix = `org/${identity.organizationId}/`;
  const candidateId = candidateKey.slice(prefix.length);
  if (
    !candidateKey.startsWith(prefix) ||
    !UUID_V7.test(candidateId) ||
    candidateId === identity.id
  ) {
    throw new AttachmentError('invalid-object-key');
  }
}

/** Validates the predecision pin and mutually exclusive Task outcomes from Storage AsyncAPI. */
function requireLifecycle(snapshot: IntakeAttachmentSnapshot): void {
  const { reservation, candidateKey, verifiedAt, taskKey, decidedAt } = snapshot;
  const hasPin = candidateKey !== null && verifiedAt !== null;
  if ((candidateKey === null) !== (verifiedAt === null) || (hasPin && reservation === null)) {
    throw new AttachmentError('invalid-state');
  }
  if (taskKey !== null && !TASK_KEY.test(taskKey)) throw new AttachmentError('invalid-identity');
  switch (snapshot.status) {
    case 'pending':
      if (reservation !== null && !hasPin && taskKey === null && decidedAt === null) return;
      break;
    case 'verified':
      if (hasPin && taskKey === null && decidedAt === null) return;
      break;
    case 'claimed':
      if (taskKey !== null && decidedAt !== null) return;
      break;
    case 'released':
      if (taskKey === null && decidedAt !== null) return;
      break;
  }
  throw new AttachmentError('invalid-state');
}

function checkedSnapshot(input: IntakeAttachmentSnapshot): IntakeAttachmentSnapshot {
  const identity = checkedIdentity(input);
  const reservation = input.reservation === null ? null : checkedReservation(input.reservation);
  const verifiedAt = input.verifiedAt === null ? null : new Date(checkedTime(input.verifiedAt));
  const decidedAt = input.decidedAt === null ? null : new Date(checkedTime(input.decidedAt));
  if (reservation !== null) {
    requireSameIdentity(identity, reservation);
    if (
      verifiedAt !== null &&
      (verifiedAt < reservation.reservedAt || verifiedAt >= reservation.expiresAt)
    ) {
      throw new AttachmentError('invalid-state');
    }
  }
  if (input.candidateKey !== null) requireCandidateKey(input.candidateKey, identity);
  const snapshot = {
    ...identity,
    status: input.status,
    reservation,
    candidateKey: input.candidateKey,
    verifiedAt,
    taskKey: input.taskKey,
    decidedAt,
  };
  requireLifecycle(snapshot);
  return snapshot;
}

/** Owns uploaded bytes for a Task intake reservation until Task commits a terminal disposition. */
export class IntakeAttachment {
  // #region Constructor
  /** Takes a validated and privately owned snapshot. */
  private constructor(private readonly state: IntakeAttachmentSnapshot) {}
  // #endregion

  // #region Properties
  /** Returns a detached snapshot, including the original signed capability cutoff. */
  public get snapshot(): IntakeAttachmentSnapshot {
    const { reservation, verifiedAt, decidedAt } = this.state;
    return {
      ...this.state,
      reservation:
        reservation === null
          ? null
          : {
              ...reservation,
              reservedAt: new Date(reservation.reservedAt),
              expiresAt: new Date(reservation.expiresAt),
              uploadExpiresAt: new Date(reservation.uploadExpiresAt),
            },
      verifiedAt: verifiedAt === null ? null : new Date(verifiedAt),
      decidedAt: decidedAt === null ? null : new Date(decidedAt),
    };
  }
  // #endregion

  // #region Methods
  /** Records the first declaration before issuing a signed POST for a Task allocation. */
  public static reserve(input: IntakeAttachmentReservation): IntakeAttachment {
    const reservation = checkedReservation(input);
    return new IntakeAttachment({
      ...checkedIdentity(reservation),
      status: 'pending',
      reservation,
      candidateKey: null,
      verifiedAt: null,
      taskKey: null,
      decidedAt: null,
    });
  }

  /** Records the release fence even if Task's terminal decision arrives before allocation. */
  public static releaseUnallocated(identity: IntakeAttachmentIdentity, at: Date): IntakeAttachment {
    return IntakeAttachment.rehydrate({
      ...identity,
      status: 'released',
      reservation: null,
      candidateKey: null,
      verifiedAt: null,
      taskKey: null,
      decidedAt: at,
    });
  }

  /** Preserves an authoritative Task claim even when this Storage reservation is missing. */
  public static claimUnallocated(
    identity: IntakeAttachmentIdentity,
    taskKey: string,
    at: Date,
  ): IntakeAttachment {
    return IntakeAttachment.rehydrate({
      ...identity,
      status: 'claimed',
      reservation: null,
      candidateKey: null,
      verifiedAt: null,
      taskKey,
      decidedAt: at,
    });
  }

  /** Restores a persisted reservation or terminal fence without a new fact. */
  public static rehydrate(snapshot: IntakeAttachmentSnapshot): IntakeAttachment {
    return new IntakeAttachment(checkedSnapshot(snapshot));
  }

  /** Replays the original declaration for the same binding, as required by the internal start route. */
  public requireReservation(input: Declaration): void {
    requireSameIdentity(this.state, checkedIdentity(input));
    const reservation = this.openReservation();
    const contentType = checkedAttachmentMediaType(
      input.fileName,
      input.contentType,
      input.sizeBytes,
    );
    if (
      input.fileName !== reservation.fileName ||
      contentType !== reservation.contentType ||
      input.sizeBytes !== reservation.sizeBytes ||
      checkedTime(input.expiresAt) !== reservation.expiresAt.getTime()
    ) {
      throw new AttachmentError('reservation-conflict');
    }
  }

  /** Requires the registered file extension's media type before signing the anonymous POST. */
  public requireExtensionMediaType(expected: string | null): void {
    requireAttachmentExtensionMediaType(expected, this.openReservation().contentType);
  }

  /** Refuses a new verification once the original signed POST expires. */
  public requireVerificationWindow(at: Date): void {
    const reservation = this.openReservation();
    if (
      this.state.status === 'pending' &&
      checkedTime(at) >= reservation.uploadExpiresAt.getTime()
    ) {
      throw new AttachmentError('upload-expired');
    }
  }

  /** Elects one matching candidate within the signed window and emits the intake verification fact. */
  public verify(
    candidateKey: string,
    verification: AttachmentVerification,
    at: Date,
  ): IntakeVerificationChange {
    const reservation = this.openReservation();
    if (this.state.status === 'verified') return { intakeAttachment: this, event: null };
    this.requireVerificationWindow(at);
    requireAttachmentVerification(verification, reservation.contentType, reservation.sizeBytes);

    const intakeAttachment = IntakeAttachment.rehydrate({
      ...this.state,
      status: 'verified',
      candidateKey,
      verifiedAt: at,
    });
    return {
      intakeAttachment,
      event: {
        type: 'intake.attachment-verified.v1',
        occurredAt: at.toISOString(),
        organizationId: this.state.organizationId,
        publicationId: this.state.publicationId,
        attachmentId: this.state.id,
        version: 1,
      },
    };
  }

  /** Records Task's claim even after draft expiry. A file needs a pin and a task without a purge fence. */
  public claim(taskKey: string, taskPurged: boolean, at: Date): IntakeClaimChange {
    if (this.state.status === 'released' || this.state.status === 'claimed') {
      return { intakeAttachment: this, attachment: null, event: null };
    }
    const intakeAttachment = IntakeAttachment.rehydrate({
      ...this.state,
      status: 'claimed',
      taskKey,
      decidedAt: at,
    });

    const { verifiedAt, organizationId, id } = this.state;
    if (taskPurged || verifiedAt === null)
      return { intakeAttachment, attachment: null, event: null };
    const reservation = this.openReservation();
    const { attachment, event } = Attachment.bindIntake(
      { ...reservation, taskKey, objectKey: `org/${organizationId}/${id}` },
      verifiedAt,
      at,
    );
    return { intakeAttachment, attachment, event };
  }

  /** Retains the cleanup references and rejects further uploads after Task's release. */
  public release(at: Date): IntakeAttachment {
    if (this.state.status === 'claimed' || this.state.status === 'released') return this;
    return IntakeAttachment.rehydrate({ ...this.state, status: 'released', decidedAt: at });
  }

  /** Exposes declarations only while Task's terminal decision is still outstanding. */
  private openReservation(): AllocatedReservation {
    if (this.state.status === 'claimed' || this.state.status === 'released') {
      throw new AttachmentError('attachment-deleted');
    }
    if (this.state.reservation === null) throw new AttachmentError('invalid-state');
    return this.state.reservation;
  }
  // #endregion
}
