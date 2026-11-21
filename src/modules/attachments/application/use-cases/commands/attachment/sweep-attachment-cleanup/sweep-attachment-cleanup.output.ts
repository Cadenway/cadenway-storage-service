/** Counts suitable for reporting a sweep without disclosing identifiers or error details. */
export interface SweepAttachmentCleanupOutput {
  // #region Properties
  /** Attachment lifecycle changes committed by task-purge batches. */
  readonly attachments: number;

  /** Objects successfully erased, including absent objects. */
  readonly objects: number;

  /** Failed discovery phases, tenant batches and object erasures. */
  readonly failures: number;
  // #endregion
}
