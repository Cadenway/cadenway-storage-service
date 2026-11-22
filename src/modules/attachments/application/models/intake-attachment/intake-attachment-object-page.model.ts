/** A bounded physical page of opaque anonymous staging keys. */
export interface IntakeAttachmentObjectPage {
  // #region Properties
  /** Opaque keys without tenant information. */
  readonly objects: readonly {
    readonly objectKey: string;
    readonly transientOnly?: true;
  }[];

  /** Provider continuation, or null at the end of the inventory. */
  readonly next: string | null;
  // #endregion
}
