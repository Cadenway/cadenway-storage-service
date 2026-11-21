import type { IntakeAttachmentIdentity } from './intake-attachment-identity.value-object.js';
import type { IntakeAttachmentReservation } from './intake-attachment-reservation.value-object.js';

/** Persisted anonymous intake lifecycle, including terminal decisions without a local reservation. */
export interface IntakeAttachmentSnapshot extends IntakeAttachmentIdentity {
  // #region Properties
  /** Lifecycle before or after Task's single terminal decision. */
  readonly status: 'pending' | 'verified' | 'claimed' | 'released';

  /** Accepted declaration with the exact signed POST expiry once the receipt has been issued. */
  readonly reservation: (IntakeAttachmentReservation & { readonly uploadExpiresAt: Date }) | null;

  /** The elected immutable object, kept on release to identify the bytes to erase. */
  readonly candidateKey: string | null;

  /** The time at which the exact candidate was verified. */
  readonly verifiedAt: Date | null;

  /** Stable task key in Task's claim, including claims without a ready attachment. */
  readonly taskKey: string | null;

  /** Time when the terminal decision was recorded. */
  readonly decidedAt: Date | null;
  // #endregion
}
