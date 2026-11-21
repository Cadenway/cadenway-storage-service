import type { Attachment } from '../../../domain/aggregates/attachment/attachment.aggregate.js';
import type { AttachmentFact } from '../../../domain/events/attachment/attachment-fact.event.js';
import type { AttachmentActor } from './attachment-actor.model.js';
import type { UploadCapability } from './upload-capability.model.js';
import type { UploadClaimConflict } from './upload-claim-conflict.model.js';

/** Tenant-scoped operations sharing one database transaction. */
export interface AttachmentTransaction {
  // #region Methods
  /**
   * Takes the task-scoped lock shared with task purge, even when no tombstone row exists,
   * and reports whether the task has been permanently purged.
   */
  lockTask(taskKey: string): Promise<boolean>;

  /** Records the task tombstone, original purge actor and bounded cleanup once. */
  registerTaskPurge(taskKey: string, actor: AttachmentActor): Promise<void>;

  /** Locks an attachment, optionally requiring the exact elected object. */
  lockAttachment(
    taskKey: string,
    attachmentId: string,
    electedObjectKey?: string,
  ): Promise<Attachment | null>;

  /** Inserts a pending reservation and stages cleanup of the upload key after expiry. */
  insertReservation(attachment: Attachment): Promise<void>;

  /** Leases the scoped key until signing finishes, or resolves an unexpired claim. */
  claimUpload(
    actorId: string,
    taskKey: string,
    key: string,
    fingerprint: string,
  ): Promise<{ readonly kind: 'acquired'; readonly claimId: string } | UploadClaimConflict>;

  /** Replaces a live, owned lease with the original encrypted response for 24-hour replay. */
  completeUploadClaim(
    actorId: string,
    taskKey: string,
    key: string,
    fingerprint: string,
    claimId: string,
    response: UploadCapability,
  ): Promise<{ readonly kind: 'completed' } | UploadClaimConflict>;

  /** Releases the caller's pending lease after signing or reservation fails. */
  releaseUploadClaim(actorId: string, taskKey: string, key: string, claimId: string): Promise<void>;

  /**
   * Registers a unique candidate and delayed cleanup before object copy.
   * Cleanup must fence the candidate under the task/attachment lock before deleting it.
   * A fenced candidate can never be elected. Its tombstone remains sweepable until the
   * adapter can prove no delayed writer can recreate the object, and each deletion is
   * repeated outside the transaction. Elected candidates are never deleted by this sweep.
   */
  registerCandidate(attachmentId: string, candidateKey: string, cleanupAfter: Date): Promise<void>;

  /** Locks the tenant quota and reads ready and reserved bytes in this transaction. */
  lockAndReadVerifiedBytes(): Promise<bigint>;

  /** Elects a still-active candidate, persists ready metadata and protects the winner from cleanup. */
  electCandidate(attachment: Attachment, candidateKey: string): Promise<boolean>;

  /** Persists deletion and durable cleanup for the accepted and staged objects. */
  deleteAttachment(attachment: Attachment): Promise<void>;

  /** Appends a domain fact and its verified actor through the transactional outbox. */
  appendFact(fact: AttachmentFact, actor: AttachmentActor): Promise<void>;
  // #endregion
}
