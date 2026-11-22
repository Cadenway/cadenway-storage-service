export { maximumTransferBytes } from '../../../domain/policies/transfers/upload-transfer.policy.js';

/** Bounded temporary file validated by the multipart adapter. */
export interface UploadTransferFile {
  // #region Properties
  /** Private temporary file selected by the multipart parser. */
  readonly path: string;

  /** Exact byte count observed by the parser. */
  readonly size: number;

  /** Media type declared by the sender for this file part. */
  readonly mimetype: string;
  // #endregion
}
