import { SystemTransactionRunner, TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { TransactionScope } from '@cadenway/nest-common/database';
import { JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import type { FactoryProvider } from '@nestjs/common';

import type { AttachmentObjectEraser } from '../../../../application/ports/outbound/object-storage/attachment/attachment-object-eraser.port.js';
import type { IntakeAttachmentObjectEraser } from '../../../../application/ports/outbound/object-storage/intake-attachment/intake-attachment-object-eraser.port.js';
import type { AttachmentCleanupTransaction } from '../../../../application/ports/outbound/persistence/attachment/attachment-cleanup-transaction.port.js';
import type { AttachmentRuntime } from '../../../../application/ports/outbound/runtime/attachment/attachment-runtime.port.js';
import { CleanAttachmentObjects } from '../../../../application/use-cases/commands/attachment/clean-attachment-objects/clean-attachment-objects.use-case.js';
import { CleanPurgedTask } from '../../../../application/use-cases/commands/attachment/clean-purged-task/clean-purged-task.use-case.js';
import { SweepAttachmentCleanup } from '../../../../application/use-cases/commands/attachment/sweep-attachment-cleanup/sweep-attachment-cleanup.use-case.js';
import { CleanIntakeAttachmentObjects } from '../../../../application/use-cases/commands/intake-attachment/clean-intake-attachment-objects/clean-intake-attachment-objects.use-case.js';
import { SweepIntakeAttachmentCleanup } from '../../../../application/use-cases/commands/intake-attachment/sweep-intake-attachment-cleanup/sweep-intake-attachment-cleanup.use-case.js';
import { PostgresAttachmentRuntime } from '../../../../infrastructure/adapters/runtime/postgres-attachment-runtime.adapter.js';
import { DrizzleAttachmentCleanupDiscovery } from '../../../../infrastructure/persistence/drizzle/repositories/attachment/drizzle-attachment-cleanup-discovery.repository.js';
import { DrizzleIntakeAttachmentCleanupDiscovery } from '../../../../infrastructure/persistence/drizzle/repositories/attachment/drizzle-intake-attachment-cleanup-discovery.repository.js';
import { DrizzleAttachmentCleanupUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/attachment/drizzle-attachment-cleanup.unit-of-work.js';
import { DrizzleIntakeAttachmentCleanupUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/attachment/drizzle-intake-attachment-cleanup.unit-of-work.js';
import { SweepAttachmentCleanupHandler } from '../../../../presentation/jobs/handlers/attachment/sweep-attachment-cleanup.handler.js';
import { ATTACHMENT_FACT_WRITER } from '../../../tokens/attachment/attachment-fact-writer.token.js';
import { ATTACHMENT_OBJECT_STORE } from '../../../tokens/attachment/attachment-object-store.token.js';

type FactWriter = (
  scope: TransactionScope,
  ...fact: Parameters<AttachmentCleanupTransaction['appendFact']>
) => Promise<void>;

/** Composes the system sweep once the attachment fact writer and commands are registered. */
export function sweepAttachmentCleanupHandlerProvider(
  queue: string,
): FactoryProvider<SweepAttachmentCleanupHandler> {
  return {
    provide: SweepAttachmentCleanupHandler,
    inject: [
      JobWorkerRegistry,
      JobScheduler,
      SystemTransactionRunner,
      TenantTransactionRunner,
      ATTACHMENT_FACT_WRITER,
      ATTACHMENT_OBJECT_STORE,
      PostgresAttachmentRuntime,
    ],
    useFactory: (
      workers: JobWorkerRegistry,
      scheduler: JobScheduler,
      system: SystemTransactionRunner,
      tenant: TenantTransactionRunner,
      writeFact: FactWriter,
      objects: AttachmentObjectEraser & IntakeAttachmentObjectEraser,
      runtime: AttachmentRuntime,
    ): SweepAttachmentCleanupHandler => {
      const cleanupWork = new DrizzleAttachmentCleanupUnitOfWork(tenant, writeFact);
      const attachments = new SweepAttachmentCleanup(
        new DrizzleAttachmentCleanupDiscovery(system),
        new CleanPurgedTask(cleanupWork, runtime),
        new CleanAttachmentObjects(cleanupWork, objects),
      );
      const intake = new SweepIntakeAttachmentCleanup(
        new DrizzleIntakeAttachmentCleanupDiscovery(system),
        new CleanIntakeAttachmentObjects(
          new DrizzleIntakeAttachmentCleanupUnitOfWork(tenant),
          objects,
        ),
      );
      return new SweepAttachmentCleanupHandler(
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
            return {
              attachments: ordinary.value.attachments,
              objects: ordinary.value.objects + anonymous.value.objects,
              failures: ordinary.value.failures + anonymous.value.failures,
            };
          },
        },
        queue,
      );
    },
  };
}
