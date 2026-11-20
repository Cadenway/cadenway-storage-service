/** Exact tenant, publication and attachment binding from the trusted Task allocation. */
export interface IntakeAttachmentIdentity {
  // #region Properties
  /** Organization that owns the reservation. */
  readonly organizationId: string;

  /** Internal identifier of the public form publication. */
  readonly publicationId: string;

  /** Attachment identifier allocated by task-service. */
  readonly id: string;
  // #endregion
}
