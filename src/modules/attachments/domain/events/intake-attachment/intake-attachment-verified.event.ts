/** Domain fact from the first immutable candidate election (AsyncAPI intake.attachment-verified.v1). */
export interface IntakeAttachmentVerified {
  // #region Properties
  /** Business fact committed with the pin. */
  readonly type: 'intake.attachment-verified.v1';

  /** Time at which the copy was elected, in UTC. */
  readonly occurredAt: string;

  /** Tenant of the allocation. */
  readonly organizationId: string;

  /** Publication associated to the reservation. */
  readonly publicationId: string;

  /** Attachment identifier originally allocated by Task. */
  readonly attachmentId: string;

  /** The single version of this immutable verification. */
  readonly version: 1;
  // #endregion
}
