import { eventSchemas, TASK_PURGED_V1 } from '@cadenway/contracts/events/task-service';
import type { TaskPurgedV1 } from '@cadenway/contracts/events/task-service';
import { requireOrganizationId } from '@cadenway/nest-common';
import type { EventConsumers, EventContext } from '@cadenway/nest-messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';

import type { RecordTaskPurge } from '../../../../application/use-cases/commands/attachment/record-task-purge/record-task-purge.use-case.js';

/** Records task revocation in the kit's durable delivery transaction. */
export class TaskPurgedHandler implements OnApplicationBootstrap {
  // #region Constructor
  /** Binds the durable subscription and the tenant-scoped purge operation. */
  public constructor(
    private readonly consumers: Pick<EventConsumers, 'subscribe'>,
    private readonly recordPurge: Pick<RecordTaskPurge, 'execute'>,
  ) {}
  // #endregion

  // #region Methods
  /** Replays retained task purges so a delayed deployment can restore the revocations. */
  public onApplicationBootstrap(): Promise<void> {
    return this.consumers.subscribe({
      handler: 'record-task-purge',
      schemas: eventSchemas,
      event: TASK_PURGED_V1,
      deliverPolicy: 'all',
      handle: (payload, context) => this.apply(payload, context),
    });
  }

  /** Claims the individual task revision and preserves the actor of its original purge. */
  private async apply(payload: TaskPurgedV1, context: EventContext): Promise<void> {
    context.signal.throwIfAborted();
    const organizationId = requireOrganizationId();
    if (organizationId !== payload.organizationId) {
      throw new Error('Task purge does not belong to its delivery tenant.');
    }
    const claimed = await context.claimVersion(`task:${payload.key}`);
    context.signal.throwIfAborted();
    if (claimed) {
      await this.recordPurge.execute({
        organizationId,
        taskKey: payload.key,
        actor: payload.actor,
      });
    }
  }
  // #endregion
}
