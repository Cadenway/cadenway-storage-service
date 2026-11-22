import type { UploadTransferResult } from '../../../../models/transfers/upload-transfer-result.model.js';
import type { UploadTransferFile } from '../../../../models/transfers/upload-transfer.model.js';

/** Redeems a ticket durably before writing its staging object. */
export interface UploadTransfer {
  // #region Methods
  /** Checks a ticket before allowing the parser to spool a file. */
  admitsFile(ticket: string, contentType: string): boolean;

  /** Claims the staging key and dispatches the exact validated payload. */
  put(ticket: string, file: UploadTransferFile): Promise<UploadTransferResult>;
  // #endregion
}
