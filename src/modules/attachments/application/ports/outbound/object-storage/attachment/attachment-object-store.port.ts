import type { AttachmentVerification } from '../../../../../domain/value-objects/attachment/attachment-verification.value-object.js';
import type { UploadCapability } from '../../../../models/attachment/upload-capability.model.js';

export { AttachmentObjectStorageError } from '../../../../models/attachment/attachment-object-storage-error.model.js';

/** External transfer operations, called outside the database transaction. */
export interface AttachmentObjectStore {
  // #region Methods
  /** Signs a five-minute constrained multipart POST for exactly the supplied staging key. */
  signUpload(input: {
    readonly attachmentId: string;
    readonly stagingKey: string;
    readonly contentType: string;
    readonly expiresAt: Date;
  }): Promise<UploadCapability>;

  /** Copies staging bytes to a unique immutable candidate and verifies that candidate. */
  copyAndVerify(input: {
    readonly stagingKey: string;
    readonly candidateKey: string;
  }): Promise<AttachmentVerification | null>;

  /** Signs a download whose content disposition is attachment with a safe filename. */
  signDownload(input: {
    readonly objectKey: string;
    readonly fileName: string;
  }): Promise<{ readonly url: string; readonly expiresAt: string }>;
  // #endregion
}
