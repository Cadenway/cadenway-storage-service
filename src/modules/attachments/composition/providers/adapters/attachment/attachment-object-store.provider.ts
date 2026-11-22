import { CONFIG } from '@cadenway/nest-common';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { UploadTransferTicket } from '../../../../../../infrastructure/object-storage/upload-transfer-ticket.js';
import type { AttachmentObjectEraser } from '../../../../application/ports/outbound/object-storage/attachment/attachment-object-eraser.port.js';
import type { AttachmentObjectInventory } from '../../../../application/ports/outbound/object-storage/attachment/attachment-object-inventory.port.js';
import type { AttachmentObjectStore } from '../../../../application/ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import type { IntakeAttachmentObjectEraser } from '../../../../application/ports/outbound/object-storage/intake-attachment/intake-attachment-object-eraser.port.js';
import type { IntakeAttachmentObjectInventory } from '../../../../application/ports/outbound/object-storage/intake-attachment/intake-attachment-object-inventory.port.js';
import type { IntakeAttachmentObjectStore } from '../../../../application/ports/outbound/object-storage/intake-attachment/intake-attachment-object-store.port.js';
import { AttachmentObjectStorageError } from '../../../../application/models/attachment/attachment-object-storage-error.model.js';
import { S3AttachmentObjectStore } from '../../../../infrastructure/adapters/object-storage/s3-attachment-object-store.adapter.js';
import { ATTACHMENT_OBJECT_STORE } from '../../../tokens/attachment/attachment-object-store.token.js';

/** Rejects transfers with the same redacted error as an unavailable configured adapter. */
function rejectTransfer(): Promise<never> {
  return Promise.reject(new AttachmentObjectStorageError());
}

type ObjectStorage = AttachmentObjectStore &
  AttachmentObjectEraser &
  AttachmentObjectInventory &
  IntakeAttachmentObjectStore &
  IntakeAttachmentObjectEraser &
  IntakeAttachmentObjectInventory;

/** Binds transfers and cleanup to the validated storage endpoints. */
export const attachmentObjectStoreProvider: FactoryProvider<ObjectStorage> = {
  provide: ATTACHMENT_OBJECT_STORE,
  inject: [CONFIG],
  useFactory: ({ objectStorage }: Readonly<AppConfig>): ObjectStorage => {
    if (objectStorage === undefined) {
      return {
        signUpload: rejectTransfer,
        copyAndVerify: rejectTransfer,
        retainCandidate: rejectTransfer,
        signDownload: rejectTransfer,
        deleteObject: rejectTransfer,
        listAttachmentObjects: rejectTransfer,
        signIntakeUpload: rejectTransfer,
        copyAndVerifyIntake: rejectTransfer,
        deleteIntakeObject: rejectTransfer,
        listIntakeObjects: rejectTransfer,
      };
    }

    return new S3AttachmentObjectStore(
      objectStorage.bucket,
      {
        endpoint: objectStorage.endpoint,
        region: objectStorage.region,
        forcePathStyle: objectStorage.forcePathStyle,
        credentials: {
          accessKeyId: objectStorage.accessKeyId,
          secretAccessKey: objectStorage.secretAccessKey,
        },
      },
      objectStorage.publicEndpoint,
      objectStorage.eraseTransientVersions,
      objectStorage.uploadTransferUrl === undefined
        ? undefined
        : new UploadTransferTicket(objectStorage.uploadTransferUrl, objectStorage.receiptKeys),
    );
  },
};
