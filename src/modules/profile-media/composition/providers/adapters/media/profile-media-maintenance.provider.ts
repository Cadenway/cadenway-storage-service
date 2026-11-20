import { CONFIG } from '@cadenway/nest-common';
import { SystemTransactionRunner, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import {
  RECONCILE_PROFILE_MEDIA_QUEUE,
  SWEEP_PROFILE_MEDIA_QUEUE,
} from '../../../../../../config/job-queues.js';
import type { ProfileMediaEraser } from '../../../../application/ports/outbound/object-storage/media/profile-media-eraser.port.js';
import type { ProfileMediaObjectInventory } from '../../../../application/ports/outbound/object-storage/media/profile-media-object-inventory.port.js';
import { CleanProfileMedia } from '../../../../application/use-cases/commands/media/clean-profile-media/clean-profile-media.use-case.js';
import { ReconcileProfileMedia } from '../../../../application/use-cases/commands/media/reconcile-profile-media/reconcile-profile-media.use-case.js';
import { SweepProfileMediaCleanup } from '../../../../application/use-cases/commands/media/sweep-profile-media-cleanup/sweep-profile-media-cleanup.use-case.js';
import { DrizzleProfileMediaCleanupDiscovery } from '../../../../infrastructure/persistence/drizzle/repositories/media/drizzle-profile-media-cleanup-discovery.repository.js';
import { DrizzleProfileMediaCleanup } from '../../../../infrastructure/persistence/drizzle/repositories/media/drizzle-profile-media-cleanup.repository.js';
import { DrizzleProfileMediaReconciliation } from '../../../../infrastructure/persistence/drizzle/repositories/media/drizzle-profile-media-reconciliation.repository.js';
import { ProfileMediaMaintenanceHandler } from '../../../../presentation/jobs/handlers/media/profile-media-maintenance.handler.js';
import { PROFILE_MEDIA_OBJECTS } from '../../../tokens/media/profile-media.token.js';

/** Composes the system discovery and recheck with the correct account or tenant runners. */
export const profileMediaMaintenanceProvider: FactoryProvider<ProfileMediaMaintenanceHandler> = {
  provide: ProfileMediaMaintenanceHandler,
  inject: [
    JobWorkerRegistry,
    JobScheduler,
    SystemTransactionRunner,
    TenantTransactionRunner,
    PROFILE_MEDIA_OBJECTS,
    CONFIG,
  ],
  useFactory: (
    workers: JobWorkerRegistry,
    scheduler: JobScheduler,
    system: SystemTransactionRunner,
    tenant: TenantTransactionRunner,
    objects: ProfileMediaEraser & ProfileMediaObjectInventory,
    config: Readonly<AppConfig>,
  ): ProfileMediaMaintenanceHandler => {
    const cleanup = new DrizzleProfileMediaCleanup(
      system,
      tenant,
      new DrizzleProfileMediaCleanupDiscovery(system),
    );
    const reconciliation = new ReconcileProfileMedia(
      new DrizzleProfileMediaReconciliation(system, tenant),
      objects,
    );
    const sweep = new SweepProfileMediaCleanup(cleanup);
    return new ProfileMediaMaintenanceHandler(
      workers,
      scheduler,
      new CleanProfileMedia(
        {
          claim: (limit) => sweep.execute(limit),
          complete: (lease) => sweep.complete(lease),
          release: (lease) => sweep.release(lease),
        },
        objects,
      ),
      (signal) => reconciliation.execute(signal),
      SWEEP_PROFILE_MEDIA_QUEUE,
      RECONCILE_PROFILE_MEDIA_QUEUE,
      config.objectStorage !== undefined,
    );
  },
};
