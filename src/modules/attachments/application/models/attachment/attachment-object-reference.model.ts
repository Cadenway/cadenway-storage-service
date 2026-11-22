/** Identifies one physical attachment object using its tenant and immutable key. */
export interface AttachmentObjectReference {
  // #region Properties
  /** Organization taken from the validated key namespace. */
  readonly organizationId: string;

  /** Full immutable attachment key. */
  readonly objectKey: string;

  /** Historical versions can rearm only a key whose ledger permits physical deletion. */
  readonly transientOnly?: true;
  // #endregion
}
