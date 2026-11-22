import { CONFIG } from '@cadenway/nest-common';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { UploadTransferTicket } from '../../../../../../infrastructure/object-storage/upload-transfer-ticket.js';
import { ProfileMediaUnavailable } from '../../../../application/models/media/profile-media-unavailable.model.js';
import type { ProfileMediaEraser } from '../../../../application/ports/outbound/object-storage/media/profile-media-eraser.port.js';
import type { ProfileMediaObjects } from '../../../../application/ports/outbound/object-storage/media/profile-media-objects.port.js';
import type { ProfileMediaObjectInventory } from '../../../../application/ports/outbound/object-storage/media/profile-media-object-inventory.port.js';
import { S3ProfileMediaObjects } from '../../../../infrastructure/adapters/object-storage/s3-profile-media-objects.adapter.js';
import { PROFILE_MEDIA_OBJECTS } from '../../../tokens/media/profile-media.token.js';

type ObjectStore = ProfileMediaObjects & ProfileMediaEraser & ProfileMediaObjectInventory;

function objectStoreUnavailable(): Promise<never> {
  return Promise.reject(new ProfileMediaUnavailable());
}

/** Uses the configured private bucket and shared signer endpoints for Profile Media. */
export const profileMediaObjectStoreProvider: FactoryProvider<ObjectStore> = {
  provide: PROFILE_MEDIA_OBJECTS,
  inject: [CONFIG],
  useFactory: ({ objectStorage }: Readonly<AppConfig>): ObjectStore => {
    if (objectStorage === undefined) {
      return {
        candidateRetention: 'preserve',
        sign: objectStoreUnavailable,
        readSource: objectStoreUnavailable,
        putCandidate: objectStoreUnavailable,
        pinCandidateForRestore: objectStoreUnavailable,
        readCandidate: objectStoreUnavailable,
        erase: objectStoreUnavailable,
        listProfileMediaObjects: objectStoreUnavailable,
      };
    }
    return new S3ProfileMediaObjects(
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
