/** One tenant-scoped task purge cleanup batch. */
export interface CleanPurgedTaskInput {
  // #region Properties
  /** Organization from the job's verified context. */
  readonly organizationId: string;

  /** Stable task key from the registered purge. */
  readonly taskKey: string;
  // #endregion
}
