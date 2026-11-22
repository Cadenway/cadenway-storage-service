import type { AttachmentVerification } from '../../../../../domain/value-objects/attachment/attachment-verification.value-object.js';
import type { UploadCapability } from '../../../../models/attachment/upload-capability.model.js';

export { AttachmentObjectStorageError } from '../../../../models/attachment/attachment-object-storage-error.model.js';

/** External transfer operations, called outside the database transaction. */
export interface AttachmentObjectStore {
  // #region Properties
  /** Whether one-shot transfers require a staging erasure grace period. */
  readonly oneShotUploads?: boolean;
  // #endregion

  // #region Methods
  /** Signs a five-minute constrained multipart POST for exactly the supplied staging key. */
  signUpload(input: {
    readonly attachmentId: string;
    readonly stagingKey: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly expiresAt: Date;
  }): Promise<UploadCapability>;

  /** Copies staging bytes to a unique immutable candidate and verifies that candidate. */
  copyAndVerify(input: {
    readonly stagingKey: string;
    readonly candidateKey: string;
    readonly sizeBytes: number;
  }): Promise<AttachmentVerification | null>;

  /** Protects a candidate's history in object storage before publishing its verified bytes. */
  retainCandidate(candidateKey: string): Promise<void>;

  /** Signs a download whose content disposition is attachment with a safe filename. */
  signDownload(input: {
    readonly objectKey: string;
    readonly fileName: string;
  }): Promise<{ readonly url: string; readonly expiresAt: string }>;
  // #endregion
}
