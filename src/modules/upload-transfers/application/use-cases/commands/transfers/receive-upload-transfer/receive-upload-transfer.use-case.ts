import type { UploadTransferResult } from '../../../../models/transfers/upload-transfer-result.model.js';
import type { UploadTransferFile } from '../../../../models/transfers/upload-transfer.model.js';
import type { UploadTransfer } from '../../../../ports/outbound/object-storage/transfers/upload-transfer.port.js';

/** Receives a validated multipart file for one staging write. */
export class ReceiveUploadTransfer {
  // #region Constructor
  /** Binds one staging transport. */
  public constructor(private readonly transfers: UploadTransfer) {}
  // #endregion

  // #region Methods
  /** Rejects an invalid target before streaming the incoming file to disk. */
  public admitsFile(ticket: string, contentType: string): boolean {
    return this.transfers.admitsFile(ticket, contentType);
  }

  /** Accepts the complete, bounded file for a single staged write. */
  public execute(ticket: string, file: UploadTransferFile): Promise<UploadTransferResult> {
    return this.transfers.put(ticket, file);
  }
  // #endregion
}
