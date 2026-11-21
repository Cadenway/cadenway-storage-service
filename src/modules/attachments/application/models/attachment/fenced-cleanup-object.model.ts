/** A durable cleanup fence with the generation of the current erasure lease. */
export interface FencedCleanupObject {
  // #region Properties
  /** Generation compared when recording the result of the external erasure. */
  readonly generation: number;

  /** Durable fenced object key in the verified tenant. */
  readonly objectKey: string;
  // #endregion
}
