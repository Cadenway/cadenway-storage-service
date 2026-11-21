/** Removes a fenced anonymous upload object in its verified tenant context. */
export interface IntakeAttachmentObjectEraser {
  // #region Methods
  /** Deletes the authorized opaque staging key or tenant-scoped candidate. */
  deleteIntakeObject(input: {
    readonly organizationId: string;
    readonly objectKey: string;
  }): Promise<void>;
  // #endregion
}
