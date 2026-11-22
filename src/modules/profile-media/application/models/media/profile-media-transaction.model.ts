import type { ProfileMediaOwner } from '../../../domain/aggregates/media/profile-media-owner.aggregate.js';
import type { ProfileMediaUpload } from '../../../domain/aggregates/media/profile-media-upload.aggregate.js';
import type { ProfileMediaOwnerBinding } from '../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';
import type { ProfileMediaCapability } from './profile-media-capability.model.js';
import type { ProfileMediaCandidateRetention } from './profile-media-candidate-retention.model.js';

/** Operations executed within the current owner-scoped transaction. */
export interface ProfileMediaTransaction {
  // #region Methods
  /** Locks or creates the owner's durable fence. Call before any reservation operation. */
  lockOwner(owner: ProfileMediaOwnerBinding): Promise<ProfileMediaOwner>;

  /** Reads the owner-bound upload after locking its owner. */
  lockUpload(owner: ProfileMediaOwnerBinding, uploadId: string): Promise<ProfileMediaUpload | null>;

  /** Records a new reservation and staging object ledger entry together. */
  insertUpload(upload: ProfileMediaUpload): Promise<void>;

  /** Persists a transition, retaining terminal tombstones. */
  saveUpload(upload: ProfileMediaUpload): Promise<void>;

  /** Persists the owner's generation and deletion fence. */
  saveOwner(owner: ProfileMediaOwner): Promise<void>;

  /** Returns the original decrypted receipt only after authorization. */
  findCapability(
    owner: ProfileMediaOwnerBinding,
    uploadId: string,
  ): Promise<ProfileMediaCapability | null>;

  /** Takes an exclusive short signing lease, or returns null when another attempt owns it. */
  claimSigning(owner: ProfileMediaOwnerBinding, uploadId: string): Promise<string | null>;

  /** Persists a receipt only while this signing lease is current. */
  completeSigning(
    owner: ProfileMediaOwnerBinding,
    uploadId: string,
    leaseId: string,
    capability: ProfileMediaCapability,
  ): Promise<boolean>;

  /** Releases an incomplete signing attempt, if it still owns the lease. */
  releaseSigning(owner: ProfileMediaOwnerBinding, uploadId: string, leaseId: string): Promise<void>;

  /** Records a unique candidate before its object is written, so cleanup can recover it. */
  registerCandidate(
    owner: ProfileMediaOwnerBinding,
    uploadId: string,
    candidateId: string,
    retention: ProfileMediaCandidateRetention,
  ): Promise<void>;

  /** Elects the prepared derivative atomically and fences other candidates for cleanup. */
  electCandidate(upload: ProfileMediaUpload, candidateId: string): Promise<boolean>;

  /** Fences only this never-elected candidate and makes its versions disposable. */
  scheduleCandidateCleanup(
    owner: ProfileMediaOwnerBinding,
    uploadId: string,
    candidateId: string,
  ): Promise<void>;

  /** Fences the staged object and any unselected candidates for bounded cleanup. */
  scheduleCleanup(owner: ProfileMediaOwnerBinding, uploadId: string): Promise<void>;

  /** Schedules bounded cleanup of all reservations belonging to a deleted owner. */
  scheduleOwnerCleanup(owner: ProfileMediaOwnerBinding): Promise<void>;
  // #endregion
}
