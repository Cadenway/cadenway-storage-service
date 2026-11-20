import { describe, expect, it, vi } from 'vitest';

import { CleanProfileMedia } from './clean-profile-media.use-case.js';

const lease = {
  owner: { kind: 'avatar' as const, id: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30' },
  uploadId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01',
  objectId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b02',
  generation: 1,
  leaseId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b03',
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

  it('releases the current lease for retry when object storage fails', async () => {
    const cleanup = {
      claim: vi.fn().mockResolvedValue([lease]),
      complete: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const objects = { erase: vi.fn().mockRejectedValue(new Error('storage unavailable')) };
    await expect(new CleanProfileMedia(cleanup, objects).execute({})).rejects.toThrow(
      'storage unavailable',
    );
    expect(cleanup.complete).not.toHaveBeenCalled();
    expect(cleanup.release).toHaveBeenCalledExactlyOnceWith(lease);
  });
});
