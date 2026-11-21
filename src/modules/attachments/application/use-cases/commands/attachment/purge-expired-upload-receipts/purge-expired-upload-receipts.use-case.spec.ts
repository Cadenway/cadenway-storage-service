import { describe, expect, it, vi } from 'vitest';

import { PurgeExpiredUploadReceipts } from './purge-expired-upload-receipts.use-case.js';

describe(PurgeExpiredUploadReceipts.name, () => {
  it('drains expired upload receipts in batches of at most 500', async () => {
    const deleteBatch = vi.fn<(limit: number) => Promise<number>>();
    deleteBatch.mockResolvedValueOnce(500).mockResolvedValueOnce(17);
    const purge = new PurgeExpiredUploadReceipts({ deleteBatch });

    await expect(purge.execute(new AbortController().signal)).resolves.toBe(517);
    expect(deleteBatch.mock.calls).toEqual([[500], [500]]);
  });

  it('stops after the current batch when the job is interrupted', async () => {
    const controller = new AbortController();
    const stop = new Error('Job stopped');
    const deleteBatch = vi.fn(() => {
      controller.abort(stop);
      return Promise.resolve(500);
    });
    const purge = new PurgeExpiredUploadReceipts({ deleteBatch });

    await expect(purge.execute(controller.signal)).rejects.toBe(stop);
    expect(deleteBatch).toHaveBeenCalledTimes(1);
  });
});
