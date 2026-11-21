/** Removes expired upload receipts in separate system transactions. */
export interface ExpiredUploadReceipts {
  // #region Methods
  /** Deletes at most the given number of unlocked expired receipts and returns the count. */
  deleteBatch(limit: number): Promise<number>;
  // #endregion
}
