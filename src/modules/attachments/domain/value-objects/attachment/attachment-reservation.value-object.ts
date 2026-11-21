/** The immutable owner, intended metadata and two same-tenant keys for a reserved upload. */
export interface AttachmentReservation {
  // #region Properties
  /** Attachment ID used by the application and by the finalized object key. */
  readonly id: string;

  /** Organization that owns the attachment. */
  readonly organizationId: string;

  /** Stable task key used by the attachment and its facts. */
  readonly taskKey: string;

  /** Verified account that reserved the attachment. */
  readonly authorUserId: string;

  /** Final object key whose writes are restricted to the service. */
  readonly objectKey: string;

  /** Separate object key available for the signed upload. */
  readonly stagingObjectKey: string;

  /** Original file basename for display and download. */
  readonly fileName: string;

  /** Concrete, parameter-free media type expected on the finalized object. */
  readonly contentType: string;

  /** Number of bytes reserved for the object. */
  readonly sizeBytes: number;

  /** Instant the reservation was opened. */
  readonly reservedAt: Date;

  /** Exclusive cutoff for finalization, supplied by the application. */
  readonly expiresAt: Date;
  // #endregion
}
