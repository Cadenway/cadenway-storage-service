import type { IntakeAttachmentIdentity } from './intake-attachment-identity.value-object.js';
import type { AttachmentReservation } from '../attachment/attachment-reservation.value-object.js';

/** Trusted Task allocation and declaration for a staged anonymous upload. */
export interface IntakeAttachmentReservation
  extends
    IntakeAttachmentIdentity,
    Pick<
      AttachmentReservation,
      'stagingObjectKey' | 'fileName' | 'contentType' | 'sizeBytes' | 'reservedAt'
    > {
  // #region Properties
  /** Exclusive draft cutoff supplied by the authorized Task allocation. */
  readonly expiresAt: Date;

  /** Latest permitted signed POST expiry, defaulting to five minutes, capped by the draft cutoff. */
  readonly uploadExpiresAt?: Date;
  // #endregion
}
