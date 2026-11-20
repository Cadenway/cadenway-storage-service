import type { FactoryProvider } from '@nestjs/common';

import { ProfileMediaUnavailable } from '../../../../application/models/media/profile-media-unavailable.model.js';
import type { ProfileMediaImageProcessor } from '../../../../application/ports/outbound/image-processing/media/profile-media-image-processor.port.js';
import type { ProfileMediaObjects } from '../../../../application/ports/outbound/object-storage/media/profile-media-objects.port.js';
import type { ProfileMediaRuntime } from '../../../../application/ports/outbound/runtime/media/profile-media-runtime.port.js';
import type { ProfileMediaUnitOfWork } from '../../../../application/ports/outbound/transactions/media/profile-media-unit-of-work.port.js';
import { AbandonProfileMedia } from '../../../../application/use-cases/commands/media/abandon-profile-media/abandon-profile-media.use-case.js';
import { ApplyProfileMediaChange } from '../../../../application/use-cases/commands/media/apply-profile-media-change/apply-profile-media-change.use-case.js';
import { DeleteProfileMediaOwner } from '../../../../application/use-cases/commands/media/delete-profile-media-owner/delete-profile-media-owner.use-case.js';
import { PrepareProfileMedia } from '../../../../application/use-cases/commands/media/prepare-profile-media/prepare-profile-media.use-case.js';
import { SignProfileMediaTransfer } from '../../../../application/use-cases/commands/media/sign-profile-media-transfer/sign-profile-media-transfer.use-case.js';
import { ReadProfileMedia } from '../../../../application/use-cases/queries/media/read-profile-media/read-profile-media.use-case.js';
import {
  ProfileMediaImageProcessingBusyError,
  ProfileMediaImageProcessor as ImageProcessorAdapter,
} from '../../../../infrastructure/adapters/image-processing/profile-media-image-processor.adapter.js';
import {
  PROFILE_MEDIA_OBJECTS,
  PROFILE_MEDIA_RUNTIME,
  PROFILE_MEDIA_UNIT_OF_WORK,
} from '../../../tokens/media/profile-media.token.js';

function withOwnerTransaction<T>(
  operation: new (work: ProfileMediaUnitOfWork) => T,
): FactoryProvider<T> {
  return {
    provide: operation,
    inject: [PROFILE_MEDIA_UNIT_OF_WORK],
    useFactory: (work: ProfileMediaUnitOfWork): T => new operation(work),
  };
}

/** Binds the transfer and owner operations to the single verifier and private object provider. */
export const profileMediaUseCaseProviders: readonly FactoryProvider[] = [
  {
    provide: ImageProcessorAdapter,
    useFactory: (): ProfileMediaImageProcessor => {
      const processor = new ImageProcessorAdapter();
      return {
        async transform(input, signal) {
          try {
            return await processor.transform(input, signal);
          } catch (error) {
            if (error instanceof ProfileMediaImageProcessingBusyError) {
              throw new ProfileMediaUnavailable();
            }
            throw error;
          }
        },
      };
    },
  },
  {
    provide: SignProfileMediaTransfer,
    inject: [PROFILE_MEDIA_UNIT_OF_WORK, PROFILE_MEDIA_OBJECTS, PROFILE_MEDIA_RUNTIME],
    useFactory: (
      work: ProfileMediaUnitOfWork,
      objects: ProfileMediaObjects,
      runtime: ProfileMediaRuntime,
    ): SignProfileMediaTransfer => new SignProfileMediaTransfer(work, objects, runtime),
  },
  {
    provide: PrepareProfileMedia,
    inject: [
      PROFILE_MEDIA_UNIT_OF_WORK,
      PROFILE_MEDIA_OBJECTS,
      ImageProcessorAdapter,
      PROFILE_MEDIA_RUNTIME,
    ],
    useFactory: (
      work: ProfileMediaUnitOfWork,
      objects: ProfileMediaObjects,
      processor: ProfileMediaImageProcessor,
      runtime: ProfileMediaRuntime,
    ): PrepareProfileMedia => new PrepareProfileMedia(work, objects, processor, runtime),
  },
  {
    provide: ReadProfileMedia,
    inject: [PROFILE_MEDIA_UNIT_OF_WORK, PROFILE_MEDIA_OBJECTS],
    useFactory: (work: ProfileMediaUnitOfWork, objects: ProfileMediaObjects): ReadProfileMedia =>
      new ReadProfileMedia(work, objects),
  },
  withOwnerTransaction(ApplyProfileMediaChange),
  withOwnerTransaction(AbandonProfileMedia),
  withOwnerTransaction(DeleteProfileMediaOwner),
];
