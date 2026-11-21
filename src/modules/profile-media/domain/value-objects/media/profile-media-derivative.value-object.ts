/** Metadata of one elected immutable PNG candidate, excluding the key and image bytes. */
export interface ProfileMediaDerivative {
  // #region Properties
  /** Private UUIDv7 for a single candidate. The public reference remains the reservation ID. */
  readonly candidateId: string;

  /** Verified encoding, dimensions in pixels, and length in bytes. */
  readonly contentType: 'image/png';
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  // #endregion
}
