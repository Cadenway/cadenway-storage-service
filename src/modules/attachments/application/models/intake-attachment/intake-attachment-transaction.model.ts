import type { Attachment } from '../../../domain/aggregates/attachment/attachment.aggregate.js';
import type { IntakeAttachment } from '../../../domain/aggregates/intake-attachment/intake-attachment.aggregate.js';
import type { AttachmentFact } from '../../../domain/events/attachment/attachment-fact.event.js';
import type { IntakeAttachmentVerified } from '../../../domain/events/intake-attachment/intake-attachment-verified.event.js';
import type { UploadCapability } from '../attachment/upload-capability.model.js';
import type { IntakeAttachmentIdentity } from './intake-attachment-identity.model.js';
import type { IntakeSigningClaim } from './intake-signing-claim.model.js';

/** Tenant-scoped operations that share one database and outbox transaction. */
export interface IntakeAttachmentTransaction {
  // #region Methods
  /** Serializes operations for an allocation, including an allocation not inserted yet. */
  lock(identity: IntakeAttachmentIdentity): Promise<IntakeAttachment | null>;

  /** Leases signing for a declaration, returns a replay or reports a competing terminal state. */
  beginSigning(attachment: IntakeAttachment): Promise<IntakeSigningClaim>;

  /** Commits the original encrypted capability only for its still-owned signing lease. */
  completeSigning(
    identity: IntakeAttachmentIdentity,
    claimId: string,
    capability: UploadCapability,
  ): Promise<{ readonly kind: 'completed' } | IntakeSigningClaim>;

  /** Releases only the still-owned lease, leaving a terminal Task decision intact. */
  releaseSigning(identity: IntakeAttachmentIdentity, claimId: string): Promise<void>;

  /** Registers a unique candidate and its cleanup before the external object copy. */
  registerCandidate(
    identity: IntakeAttachmentIdentity,
    candidateKey: string,
    cleanupAfter: Date,
  ): Promise<void>;

  /** Locks the tenant quota and reads ready and reserved bytes in this transaction. */
  lockAndReadVerifiedBytes(): Promise<bigint>;

  /** Elects and pins an unfenced candidate, persisting verification and its outbox fact atomically. */
  electVerified(
    identity: IntakeAttachmentIdentity,
    attachment: IntakeAttachment,
    candidateKey: string,
    fact: IntakeAttachmentVerified,
  ): Promise<boolean>;

  /** Serializes a claim against permanent task purge and returns whether the task is purged. */
  lockTask(taskKey: string): Promise<boolean>;

  /** Saves the Task decision, metadata, cleanup and any file fact atomically. */
  saveDecision(
    identity: IntakeAttachmentIdentity,
    intake: IntakeAttachment,
    attachment: Attachment | null,
    fact: AttachmentFact | null,
  ): Promise<void>;
  // #endregion
}
