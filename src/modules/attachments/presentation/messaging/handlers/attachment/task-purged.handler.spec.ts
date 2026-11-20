import { eventSchemas, TASK_PURGED_V1 } from '@cadenway/contracts/events/task-service';
import type { TaskPurgedV1 } from '@cadenway/contracts/events/task-service';
import { runWithOrganizationContext } from '@cadenway/nest-common';
import type { EventConsumers, EventContext } from '@cadenway/nest-messaging';
import { describe, expect, it, vi } from 'vitest';

import type { RecordTaskPurge } from '../../../../application/use-cases/commands/attachment/record-task-purge/record-task-purge.use-case.js';
import { TaskPurgedHandler } from './task-purged.handler.js';

const purge: TaskPurgedV1 = {
  id: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d28',
  occurredAt: '2026-11-26T03:00:00Z',
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  actor: { type: 'user', id: '019a5f3c-9e1f-7b2a-8c3d-4e5f6a7b8c31' },
  version: 6,
  key: 'CAD-482',
  entryId: '019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e02',
  rootKey: 'CAD-447',
  spaceId: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e01',
  listId: '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f11',
  parentKey: 'CAD-447',
};

async function fixture() {
  const subscribe = vi.fn<EventConsumers['subscribe']>().mockResolvedValue(undefined);
  const execute = vi.fn<RecordTaskPurge['execute']>().mockResolvedValue(undefined);
  const claimVersion = vi.fn<EventContext['claimVersion']>().mockResolvedValue(true);
  const controller = new AbortController();
  const context: EventContext = {
    deliveryCount: 1,
    streamSequence: 1,
    redelivered: false,
    signal: controller.signal,
    claimVersion,
  };
  await new TaskPurgedHandler({ subscribe }, { execute }).onApplicationBootstrap();
  const registration = subscribe.mock.calls[0]?.[0];
  if (registration === undefined) throw new Error('The purge consumer was not registered.');
  const deliver = (organizationId = purge.organizationId): Promise<void> =>
    runWithOrganizationContext({ organizationId, actor: purge.actor, role: null, scopes: [] }, () =>
      registration.handle(purge, context),
    );
  return { registration, deliver, execute, claimVersion, controller };
}

describe(TaskPurgedHandler.name, () => {
  it('replays retained purge facts and records the individual task with its original actor', async () => {
    const { registration, deliver, execute, claimVersion } = await fixture();

    expect(registration).toMatchObject({
      handler: 'record-task-purge',
      schemas: eventSchemas,
      event: TASK_PURGED_V1,
      deliverPolicy: 'all',
    });
    await deliver();

    expect(claimVersion).toHaveBeenCalledExactlyOnceWith('task:CAD-482');
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      organizationId: purge.organizationId,
      taskKey: purge.key,
      actor: purge.actor,
    });
  });

  it('leaves the cleanup unchanged when the task revision was already applied', async () => {
    const { deliver, execute, claimVersion } = await fixture();
    claimVersion.mockResolvedValueOnce(false);

    await deliver();

    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a delivery for another organization before claiming the revision', async () => {
    const { deliver, execute, claimVersion } = await fixture();

    await expect(deliver('019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30')).rejects.toThrow(
      'Task purge does not belong to its delivery tenant.',
    );
    expect(claimVersion).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops before recording the cleanup when the delivery is abandoned during the claim', async () => {
    const { deliver, execute, claimVersion, controller } = await fixture();
    claimVersion.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(true);
    });

    await expect(deliver()).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
  });
});
