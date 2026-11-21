import { CONFIG } from '@cadenway/nest-common';
import { SystemTransactionRunner } from '@cadenway/nest-common/database';
import { JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import type { AttachmentObjectInventory } from '../../../../application/ports/outbound/object-storage/attachment/attachment-object-inventory.port.js';
import { ReconcileAttachmentObjects } from '../../../../application/use-cases/commands/attachment/reconcile-attachment-objects/reconcile-attachment-objects.use-case.js';
import { DrizzleAttachmentReconciliation } from '../../../../infrastructure/persistence/drizzle/repositories/attachment/drizzle-attachment-reconciliation.repository.js';
import { ReconcileAttachmentObjectsHandler } from '../../../../presentation/jobs/handlers/attachment/reconcile-attachment-objects.handler.js';
import { ATTACHMENT_OBJECT_STORE } from '../../../tokens/attachment/attachment-object-store.token.js';

/** Binds reconciliation to the service's object bucket and system PostgreSQL runner. */
export function reconcileAttachmentObjectsHandlerProvider(
  queue: string,
): FactoryProvider<ReconcileAttachmentObjectsHandler> {
  return {
    provide: ReconcileAttachmentObjectsHandler,
    inject: [
      JobWorkerRegistry,
      JobScheduler,
      SystemTransactionRunner,
      ATTACHMENT_OBJECT_STORE,
      CONFIG,
    ],
    useFactory: (
      workers: JobWorkerRegistry,
      scheduler: JobScheduler,
      system: SystemTransactionRunner,
      inventory: AttachmentObjectInventory,
      config: Readonly<AppConfig>,
    ): ReconcileAttachmentObjectsHandler =>
      new ReconcileAttachmentObjectsHandler(
        workers,
        scheduler,
        new ReconcileAttachmentObjects(new DrizzleAttachmentReconciliation(system), inventory),
        queue,
        config.objectStorage !== undefined,
      ),
  };
}
