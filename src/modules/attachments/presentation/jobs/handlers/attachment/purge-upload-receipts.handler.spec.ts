import type { Job, JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { describe, expect, it, vi } from 'vitest';

import { PurgeExpiredUploadReceipts } from '../../../../application/use-cases/commands/attachment/purge-expired-upload-receipts/purge-expired-upload-receipts.use-case.js';
import { PurgeUploadReceiptsHandler } from './purge-upload-receipts.handler.js';

const queue = 'storage.purge-upload-receipts';

function fixture(organizationId: string | null) {
  const job: Job = {
    id: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24',
    queue,
    organizationId,
    attempt: 1,
    payload: null,
    signal: new AbortController().signal,
  };
  const work = vi.fn<JobWorkerRegistry['work']>().mockResolvedValue(undefined);
  const schedule = vi.fn<JobScheduler['schedule']>().mockResolvedValue(undefined);
  const unschedule = vi.fn<JobScheduler['unschedule']>().mockResolvedValue(undefined);
  const deleteBatch = vi.fn<(limit: number) => Promise<number>>().mockResolvedValue(0);
  const purge = new PurgeExpiredUploadReceipts({ deleteBatch });
  const handler = new PurgeUploadReceiptsHandler({ work }, { schedule, unschedule }, purge, queue);
  return { handler, job, work, schedule, deleteBatch };
}

describe(PurgeUploadReceiptsHandler.name, () => {
  it('registers a minutely UTC schedule and runs the system worker', async () => {
    const { handler, job, work, schedule, deleteBatch } = fixture(null);

    await handler.onApplicationBootstrap();

    expect(schedule).toHaveBeenCalledWith(queue, '* * * * *', { key: 'minutely', timeZone: 'UTC' });
    expect(work).toHaveBeenCalledWith(queue, expect.any(Function));
    await work.mock.calls[0]?.[1](job);
    expect(deleteBatch).toHaveBeenCalledExactlyOnceWith(500);
  });

  it('rejects a tenant job before opening a system cleanup batch', async () => {
    const { handler, job, deleteBatch } = fixture('01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10');

    await expect(handler.handle(job)).rejects.toThrow(
      'Upload receipt cleanup requires a system job.',
    );
    expect(deleteBatch).not.toHaveBeenCalled();
  });
});
