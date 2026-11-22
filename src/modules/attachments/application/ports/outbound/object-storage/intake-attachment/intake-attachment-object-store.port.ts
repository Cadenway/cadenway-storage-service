import type { AttachmentVerification } from '../../../../../domain/value-objects/attachment/attachment-verification.value-object.js';
import type { UploadCapability } from '../../../../models/attachment/upload-capability.model.js';

/** Anonymous transfer operations; the tenant remains explicit while the staging key is opaque. */
export interface IntakeAttachmentObjectStore {
  // #region Properties
  /** Whether an allocated staging key may receive only its original transfer grant. */
  readonly oneShotUploads?: boolean;
  // #endregion

  // #region Methods
  /** Signs one bounded POST to the private, unguessable intake staging key. */
  signIntakeUpload(input: {
    readonly organizationId: string;
    readonly attachmentId: string;
    readonly stagingKey: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly expiresAt: Date;
  }): Promise<UploadCapability>;

  /** Copies the opaque staging bytes to one immutable key within the signed tenant. */
  copyAndVerifyIntake(input: {
    readonly organizationId: string;
    readonly stagingKey: string;
    readonly candidateKey: string;
    readonly sizeBytes: number;
  }): Promise<AttachmentVerification | null>;

  /** Protects a candidate's history before a verified pin can be included in a backup. */
  retainCandidate(candidateKey: string): Promise<void>;
  // #endregion
}
