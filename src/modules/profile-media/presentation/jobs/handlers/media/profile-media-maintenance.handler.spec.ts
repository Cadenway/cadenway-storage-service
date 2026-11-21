import type { Job, JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { describe, expect, it, vi } from 'vitest';

import type { CleanProfileMedia } from '../../../../application/use-cases/commands/media/clean-profile-media/clean-profile-media.use-case.js';
import { ProfileMediaMaintenanceHandler } from './profile-media-maintenance.handler.js';

const sweepQueue = 'storage.sweep-profile-media';
const inventoryQueue = 'storage.reconcile-profile-media';

function fixture(enabled = true) {
  const work = vi.fn<JobWorkerRegistry['work']>().mockResolvedValue(undefined);
  const schedule = vi.fn<JobScheduler['schedule']>().mockResolvedValue(undefined);
  const unschedule = vi.fn<JobScheduler['unschedule']>().mockResolvedValue(undefined);
  const cleanup = vi.fn<CleanProfileMedia['execute']>().mockResolvedValue({ deleted: 0 });
  const reconcile = vi.fn<(signal: AbortSignal) => Promise<number>>().mockResolvedValue(0);
  const handler = new ProfileMediaMaintenanceHandler(
    { work },
    { schedule, unschedule },
    { execute: cleanup },
    reconcile,
    sweepQueue,
    inventoryQueue,
    enabled,
  );
  const controller = new AbortController();
  const job = (queue: string, organizationId: string | null = null): Job => ({
    id: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24',
    queue,
    organizationId,
    attempt: 1,
    payload: null,
    signal: controller.signal,
  });
  const run = async (value: Job): Promise<void> => {
    const registration = work.mock.calls.find(([queue]) => queue === value.queue);
    if (registration === undefined) throw new Error('Expected a scheduled profile worker.');
    await registration[1](value);
  };
  return { handler, cleanup, reconcile, schedule, work, job, run, controller };
}

describe(ProfileMediaMaintenanceHandler.name, () => {
  it('keeps the eight owner batches independent of external inventory and continues after empty pages', async () => {
    const { handler, cleanup, reconcile, schedule, job, run, controller } = fixture();
    await handler.onApplicationBootstrap();
    expect(schedule.mock.calls).toEqual(
      [sweepQueue, inventoryQueue].map((queue) => [
        queue,
        '* * * * *',
        { key: 'minutely', timeZone: 'UTC' },
      ]),
    );
    await run(job(sweepQueue));
    expect(cleanup).toHaveBeenCalledTimes(8);
    expect(reconcile).not.toHaveBeenCalled();
    await run(job(inventoryQueue));
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(controller.signal);
  });

  it('does not advance a tenant job or a cancelled inventory', async () => {
    const { handler, cleanup, reconcile, job, run, controller } = fixture();
    await handler.onApplicationBootstrap();
    await expect(run(job(sweepQueue, '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f'))).rejects.toThrow(
      'system job',
    );
    controller.abort();
    await expect(run(job(inventoryQueue))).rejects.toMatchObject({ name: 'AbortError' });
    expect(cleanup).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('registers no maintenance in an environment without object storage', async () => {
    const { handler, schedule, work } = fixture(false);
    await handler.onApplicationBootstrap();
    expect(schedule).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
});
