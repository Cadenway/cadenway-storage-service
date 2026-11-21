import { getOrganizationContext } from '@cadenway/nest-common';
import type { Job, JobScheduler, JobWorkerRegistry } from '@cadenway/nest-jobs/runtime';
import { describe, expect, it, vi } from 'vitest';

import type { AttachmentCleanupDiscovery } from '../../../../application/ports/outbound/persistence/attachment/attachment-cleanup-discovery.port.js';
import type { CleanAttachmentObjects } from '../../../../application/use-cases/commands/attachment/clean-attachment-objects/clean-attachment-objects.use-case.js';
import type { CleanPurgedTask } from '../../../../application/use-cases/commands/attachment/clean-purged-task/clean-purged-task.use-case.js';
import { SweepAttachmentCleanup } from '../../../../application/use-cases/commands/attachment/sweep-attachment-cleanup/sweep-attachment-cleanup.use-case.js';
import { SweepAttachmentCleanupHandler } from './sweep-attachment-cleanup.handler.js';

const queue = 'storage.sweep-attachment-cleanup';
const atelierNordId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const otherOrganizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e11';
const firstTask = { organizationId: atelierNordId, taskKey: 'CAD-482' };
const secondTask = { organizationId: otherOrganizationId, taskKey: 'CAD-483' };

function fixture(organizationId: string | null = null) {
  const controller = new AbortController();
  const job: Job = {
    id: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24',
    queue,
    organizationId,
    attempt: 1,
    payload: null,
    signal: controller.signal,
  };
  const work = vi.fn<JobWorkerRegistry['work']>().mockResolvedValue(undefined);
  const schedule = vi.fn<JobScheduler['schedule']>().mockResolvedValue(undefined);
  const unschedule = vi.fn<JobScheduler['unschedule']>().mockResolvedValue(undefined);
  const listPurgedTasks = vi
    .fn<AttachmentCleanupDiscovery['listPurgedTasks']>()
    .mockResolvedValue([]);
  const listDueObjectOrganizations = vi
    .fn<AttachmentCleanupDiscovery['listDueObjectOrganizations']>()
    .mockResolvedValue([]);
  const purge = vi
    .fn<CleanPurgedTask['execute']>()
    .mockResolvedValue({ processed: 0, more: false });
  const erase = vi
    .fn<CleanAttachmentObjects['execute']>()
    .mockResolvedValue({ processed: 0, failed: 0, next: null });
  const sweep = new SweepAttachmentCleanup(
    { listPurgedTasks, listDueObjectOrganizations },
    { execute: purge },
    { execute: erase },
  );
  const handler = new SweepAttachmentCleanupHandler(
    { work },
    { schedule, unschedule },
    sweep,
    queue,
  );
  return {
    controller,
    handler,
    job,
    work,
    schedule,
    listPurgedTasks,
    listDueObjectOrganizations,
    purge,
    erase,
  };
}

describe(SweepAttachmentCleanupHandler.name, () => {
  it('schedules a durable minutely system sweep', async () => {
    const { handler, job, work, schedule, listPurgedTasks, listDueObjectOrganizations } = fixture();

    await handler.onApplicationBootstrap();

    expect(schedule).toHaveBeenCalledExactlyOnceWith(queue, '* * * * *', {
      key: 'minutely',
      timeZone: 'UTC',
    });
    expect(work).toHaveBeenCalledExactlyOnceWith(queue, expect.any(Function));
    await work.mock.calls[0]?.[1](job);
    expect(listPurgedTasks).toHaveBeenCalledExactlyOnceWith(null);
    expect(listDueObjectOrganizations).toHaveBeenCalledExactlyOnceWith(expect.any(Date), null);
  });

  it('advances both discovery cursors and scopes each cleanup to its stored organization', async () => {
    const { handler, job, listPurgedTasks, listDueObjectOrganizations, purge, erase } = fixture();
    const next = { cleanupAfter: new Date('2026-11-08T08:05:00.000Z'), objectKey: 'candidate' };
    listPurgedTasks.mockImplementation((after) => {
      expect(getOrganizationContext()).toBeUndefined();
      if (after === null) return Promise.resolve([firstTask]);
      return Promise.resolve(after === firstTask ? [secondTask] : []);
    });
    listDueObjectOrganizations.mockImplementation((_cutoff, after) => {
      expect(getOrganizationContext()).toBeUndefined();
      if (after === null) return Promise.resolve([atelierNordId]);
      return Promise.resolve(after === atelierNordId ? [otherOrganizationId] : []);
    });
    purge.mockImplementation(({ organizationId }) => {
      expect(getOrganizationContext()).toEqual({
        organizationId,
        actor: { type: 'system', id: null },
        role: null,
        scopes: [],
      });
      return Promise.resolve({ processed: 500, more: true });
    });
    erase.mockImplementation(({ organizationId, after }) => {
      expect(getOrganizationContext()?.organizationId).toBe(organizationId);
      return Promise.resolve({
        processed: 1,
        failed: 0,
        next: organizationId === atelierNordId && after === null ? next : null,
      });
    });

    await handler.handle(job);

    expect(listPurgedTasks.mock.calls).toEqual([[null], [firstTask], [secondTask]]);
    expect(purge.mock.calls).toEqual([[firstTask], [secondTask]]);
    const cutoff = listDueObjectOrganizations.mock.calls[0]?.[0];
    expect(listDueObjectOrganizations.mock.calls).toEqual([
      [cutoff, null],
      [cutoff, atelierNordId],
      [cutoff, otherOrganizationId],
    ]);
    expect(erase.mock.calls).toEqual([
      [{ organizationId: atelierNordId, cutoff, after: null, signal: job.signal }],
      [{ organizationId: atelierNordId, cutoff, after: next, signal: job.signal }],
      [{ organizationId: otherOrganizationId, cutoff, after: null, signal: job.signal }],
    ]);
  });

  it('retries the sweep after isolated errors while processing later work', async () => {
    const { handler, job, listPurgedTasks, listDueObjectOrganizations, purge, erase } = fixture();
    const next = { cleanupAfter: new Date('2026-11-08T08:05:00.000Z'), objectKey: 'candidate' };
    listPurgedTasks.mockResolvedValueOnce([firstTask, secondTask]);
    listDueObjectOrganizations.mockResolvedValueOnce([atelierNordId, otherOrganizationId]);
    purge.mockRejectedValueOnce(new Error('task details'));
    erase
      .mockResolvedValueOnce({ processed: 0, failed: 1, next })
      .mockRejectedValueOnce(new Error('storage details'));

    await expect(handler.handle(job)).rejects.toThrow('Attachment cleanup sweep failed.');

    expect(purge).toHaveBeenNthCalledWith(2, secondTask);
    expect(erase).toHaveBeenNthCalledWith(2, expect.objectContaining({ after: next }));
    expect(erase).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ organizationId: otherOrganizationId }),
    );
  });

  it('continues object discovery when system task discovery fails', async () => {
    const { handler, job, listPurgedTasks, listDueObjectOrganizations } = fixture();
    listPurgedTasks.mockRejectedValueOnce(new Error('database details'));

    await expect(handler.handle(job)).rejects.toThrow('Attachment cleanup sweep failed.');
    expect(listDueObjectOrganizations).toHaveBeenCalledExactlyOnceWith(expect.any(Date), null);
  });

  it('refuses a tenant job before reading system storage tables', async () => {
    const { handler, job, listPurgedTasks, listDueObjectOrganizations } =
      fixture(otherOrganizationId);

    await expect(handler.handle(job)).rejects.toThrow('Attachment cleanup requires a system job.');
    expect(listPurgedTasks).not.toHaveBeenCalled();
    expect(listDueObjectOrganizations).not.toHaveBeenCalled();
  });

  it('stops dispatching other tasks and phases after cancellation', async () => {
    const { controller, handler, job, listPurgedTasks, listDueObjectOrganizations, purge } =
      fixture();
    listPurgedTasks.mockResolvedValueOnce([firstTask, secondTask]);
    purge.mockImplementationOnce(() => {
      controller.abort(new Error('job cancelled'));
      return Promise.resolve({ processed: 0, more: true });
    });

    await expect(handler.handle(job)).rejects.toThrow('job cancelled');
    expect(purge).toHaveBeenCalledExactlyOnceWith(firstTask);
    expect(listDueObjectOrganizations).not.toHaveBeenCalled();
  });
});
