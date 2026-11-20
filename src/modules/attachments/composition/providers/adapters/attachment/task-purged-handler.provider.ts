import { EventConsumers } from '@cadenway/nest-messaging';
import type { FactoryProvider } from '@nestjs/common';

import { RecordTaskPurge } from '../../../../application/use-cases/commands/attachment/record-task-purge/record-task-purge.use-case.js';
import { TaskPurgedHandler } from '../../../../presentation/messaging/handlers/attachment/task-purged.handler.js';

/** Registers the task purge consumer against the Storage-owned revocation operation. */
export const taskPurgedHandlerProvider: FactoryProvider<TaskPurgedHandler> = {
  provide: TaskPurgedHandler,
  inject: [EventConsumers, RecordTaskPurge],
  useFactory: (consumers: EventConsumers, recordPurge: RecordTaskPurge): TaskPurgedHandler =>
    new TaskPurgedHandler(consumers, recordPurge),
};
