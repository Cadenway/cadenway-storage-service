import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';

import { noStoreProfileMedia } from '../../infrastructure/http/no-store-profile-media.middleware.js';
import { profileMediaEventsProvider } from './composition/providers/adapters/media/profile-media-events.provider.js';
import { profileMediaMaintenanceProvider } from './composition/providers/adapters/media/profile-media-maintenance.provider.js';
import { profileMediaObjectStoreProvider } from './composition/providers/adapters/media/profile-media-object-store.provider.js';
import { profileMediaRuntimeProvider } from './composition/providers/adapters/media/profile-media-runtime.provider.js';
import { profileMediaUnitOfWorkProvider } from './composition/providers/adapters/media/profile-media-unit-of-work.provider.js';
import { profileMediaUseCaseProviders } from './composition/providers/use-cases/media/profile-media.use-cases.provider.js';
import { ProfileMediaController } from './presentation/http/controllers/media/profile-media.controller.js';

/** Composition boundary for private avatar and organization logo storage. */
@Module({
  controllers: [ProfileMediaController],
  providers: [
    profileMediaRuntimeProvider,
    profileMediaUnitOfWorkProvider,
    profileMediaObjectStoreProvider,
    profileMediaEventsProvider,
    profileMediaMaintenanceProvider,
    ...profileMediaUseCaseProviders,
  ],
})
export class ProfileMediaModule implements NestModule {
  // #region Methods
  /** Keeps authorization and validation responses out of caches. */
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(noStoreProfileMedia).forRoutes(ProfileMediaController);
  }
  // #endregion
}
