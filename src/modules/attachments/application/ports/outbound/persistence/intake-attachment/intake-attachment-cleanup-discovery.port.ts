/** Pages organizations with due anonymous attachment objects. */
export interface IntakeAttachmentCleanupDiscovery {
  // #region Methods
  /** Finds the next ordered organizations with cleanup work at the cutoff. */
  listDueObjectOrganizations(cutoff: Date, after: string | null): Promise<readonly string[]>;
  // #endregion
}
