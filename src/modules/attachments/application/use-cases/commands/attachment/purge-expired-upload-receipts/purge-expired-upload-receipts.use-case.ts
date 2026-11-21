import type { ExpiredUploadReceipts } from '../../../../ports/outbound/persistence/attachment/expired-upload-receipts.port.js';

const BATCH_SIZE = 500;

/** Purges expired upload receipts without holding a transaction open between batches. */
export class PurgeExpiredUploadReceipts {
  // #region Constructor
  /** Binds the system-only receipt cleanup storage. */
  public constructor(private readonly receipts: ExpiredUploadReceipts) {}
  // #endregion

  // #region Methods
  /** Drains available expired receipts and stops starting batches when the job is interrupted. */
  public async execute(signal: AbortSignal): Promise<number> {
    let purged = 0;
    let count: number;
    do {
      signal.throwIfAborted();
      count = await this.receipts.deleteBatch(BATCH_SIZE);
      purged += count;
    } while (count === BATCH_SIZE);
    return purged;
  }
  // #endregion
}
