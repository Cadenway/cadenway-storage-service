/** Validated upload request with its verified tenant and actor. */
export interface StartAttachmentUploadInput {
  // #region Properties
  /** Verified caller and task scope. */
  readonly organizationId: string;
  readonly actorId: string;
  readonly taskKey: string;

  /** Declared attachment metadata. */
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;

  /** Optional client claim and its canonical request fingerprint. */
  readonly idempotencyKey?: string;
  readonly fingerprint: string;
  // #endregion
}
