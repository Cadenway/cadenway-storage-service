import { CONFIG } from '@cadenway/nest-common';
import { SystemTransactionRunner } from '@cadenway/nest-common/database';
import { JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import type { AttachmentObjectInventory } from '../../../../application/ports/outbound/object-storage/attachment/attachment-object-inventory.port.js';
import type { IntakeAttachmentObjectInventory } from '../../../../application/ports/outbound/object-storage/intake-attachment/intake-attachment-object-inventory.port.js';
import { ReconcileAttachmentObjects } from '../../../../application/use-cases/commands/attachment/reconcile-attachment-objects/reconcile-attachment-objects.use-case.js';
import { ReconcileIntakeAttachmentObjects } from '../../../../application/use-cases/commands/intake-attachment/reconcile-intake-attachment-objects/reconcile-intake-attachment-objects.use-case.js';
import {
  DrizzleAttachmentReconciliation,
  DrizzleIntakeAttachmentReconciliation,
} from '../../../../infrastructure/persistence/drizzle/repositories/attachment/drizzle-attachment-reconciliation.repository.js';
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
      inventory: AttachmentObjectInventory & IntakeAttachmentObjectInventory,
      config: Readonly<AppConfig>,
    ): ReconcileAttachmentObjectsHandler => {
      const attachments = new ReconcileAttachmentObjects(
        new DrizzleAttachmentReconciliation(system),
        inventory,
      );
      const intake = new ReconcileIntakeAttachmentObjects(
        new DrizzleIntakeAttachmentReconciliation(system),
        inventory,
      );
      return new ReconcileAttachmentObjectsHandler(
        workers,
        scheduler,
        {
          async execute(input) {
            const [ordinary, anonymous] = await Promise.allSettled([
              attachments.execute(input),
              intake.execute(input),
            ]);
            if (ordinary.status === 'rejected') throw ordinary.reason;
            if (anonymous.status === 'rejected') throw anonymous.reason;
            return { requeued: ordinary.value.requeued + anonymous.value.requeued };
          },
        },
        queue,
        config.objectStorage !== undefined,
      );
    },
  };
}
