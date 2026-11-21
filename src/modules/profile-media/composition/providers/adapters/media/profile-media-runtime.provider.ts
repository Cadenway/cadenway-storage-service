import { SystemTransactionRunner } from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import type { ProfileMediaRuntime } from '../../../../application/ports/outbound/runtime/media/profile-media-runtime.port.js';
import { PostgresProfileMediaRuntime } from '../../../../infrastructure/adapters/runtime/postgres-profile-media-runtime.adapter.js';
import { PROFILE_MEDIA_RUNTIME } from '../../../tokens/media/profile-media.token.js';

/** Allocates candidate UUIDv7 identifiers without reading any tenant or account data. */
export const profileMediaRuntimeProvider: FactoryProvider<ProfileMediaRuntime> = {
  provide: PROFILE_MEDIA_RUNTIME,
  inject: [SystemTransactionRunner],
  useFactory: (system: SystemTransactionRunner): ProfileMediaRuntime =>
    new PostgresProfileMediaRuntime(system),
};
