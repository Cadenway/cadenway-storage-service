import { describe, expect, it, vi } from 'vitest';

import { CleanProfileMedia } from './clean-profile-media.use-case.js';

const lease = {
  owner: { kind: 'avatar' as const, id: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30' },
  uploadId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01',
  objectId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b02',
  generation: 1,
  leaseId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b03',
};
const failedLease = {
  ...lease,
  objectId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b04',
  leaseId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b05',
};
const pendingLease = {
  ...lease,
  objectId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b06',
  leaseId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b07',
};

describe('CleanProfileMedia', () => {
  it('claims a bounded batch and acknowledges a successfully erased generation', async () => {
    const cleanup = {
      claim: vi.fn().mockResolvedValue([lease]),
      complete: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const objects = { erase: vi.fn().mockResolvedValue(undefined) };
    expect(await new CleanProfileMedia(cleanup, objects).execute({})).toEqual({ deleted: 1 });
    expect(cleanup.claim).toHaveBeenCalledWith(500);
    expect(cleanup.complete).toHaveBeenCalledExactlyOnceWith(lease);
    expect(cleanup.release).not.toHaveBeenCalled();
  });

  it('releases unfinished leases in one call and preserves the erasure error if release fails', async () => {
    const error = new Error('storage unavailable');
    const cleanup = {
      claim: vi.fn().mockResolvedValue([lease, failedLease, pendingLease]),
      complete: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockRejectedValue(new Error('lease release unavailable')),
    };
    const objects = {
      erase: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(error),
    };
    await expect(new CleanProfileMedia(cleanup, objects).execute({})).rejects.toBe(error);
    expect(objects.erase.mock.calls).toEqual([
      [lease, undefined],
      [failedLease, undefined],
    ]);
    expect(cleanup.complete).toHaveBeenCalledExactlyOnceWith(lease);
    expect(cleanup.release).toHaveBeenCalledExactlyOnceWith([failedLease, pendingLease]);
  });

  it('releases the whole batch when cancelled during the claim', async () => {
    const controller = new AbortController();
    const reason = new Error('job cancelled');
    const cleanup = {
      claim: vi.fn().mockImplementation(() => {
        controller.abort(reason);
        return Promise.resolve([lease, pendingLease]);
      }),
      complete: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const objects = { erase: vi.fn().mockResolvedValue(undefined) };
    await expect(
      new CleanProfileMedia(cleanup, objects).execute({ signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(objects.erase).not.toHaveBeenCalled();
    expect(cleanup.complete).not.toHaveBeenCalled();
    expect(cleanup.release).toHaveBeenCalledExactlyOnceWith([lease, pendingLease]);
  });
});
