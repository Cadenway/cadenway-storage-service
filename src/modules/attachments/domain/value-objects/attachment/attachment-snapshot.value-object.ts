import type { AttachmentReservation } from './attachment-reservation.value-object.js';

/** Persisted lifecycle state. Only an attachment that reached ready has an uploadedAt. */
export interface AttachmentSnapshot extends AttachmentReservation {
  // #region Properties
  /** Lifecycle status, including a tombstone for discarded reservations. */
  readonly status: 'pending' | 'ready' | 'deleted';

  /** Monotone lifecycle revision. The first visible ready version is one. */
  readonly version: number;

  /** Verification instant if the attachment reached ready. */
  readonly uploadedAt: Date | null;

  /** Removal or discard instant if the attachment is deleted. */
  readonly deletedAt: Date | null;
  // #endregion
}
