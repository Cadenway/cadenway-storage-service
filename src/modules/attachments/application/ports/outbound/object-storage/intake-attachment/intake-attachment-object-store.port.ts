import type { AttachmentVerification } from '../../../../../domain/value-objects/attachment/attachment-verification.value-object.js';
import type { UploadCapability } from '../../../../models/attachment/upload-capability.model.js';

/** Anonymous transfer operations; the tenant remains explicit while the staging key is opaque. */
export interface IntakeAttachmentObjectStore {
  // #region Methods
  /** Signs one bounded POST to the private, unguessable intake staging key. */
  signIntakeUpload(input: {
    readonly organizationId: string;
    readonly attachmentId: string;
    readonly stagingKey: string;
    readonly contentType: string;
    readonly expiresAt: Date;
  }): Promise<UploadCapability>;

  /** Copies the opaque staging bytes to one immutable key within the signed tenant. */
  copyAndVerifyIntake(input: {
    readonly organizationId: string;
    readonly stagingKey: string;
    readonly candidateKey: string;
  }): Promise<AttachmentVerification | null>;
  // #endregion
}
