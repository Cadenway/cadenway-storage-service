import { describe, expect, it, vi } from 'vitest';

import { ReconcileIntakeAttachmentObjects } from './reconcile-intake-attachment-objects.use-case.js';

describe('ReconcileIntakeAttachmentObjects', () => {
  it('advances the opaque inventory only after processing the leased page', async () => {
    const page = { objects: [{ objectKey: 'intake/opaque' }], next: 'continuation' };
    const reconciliation = {
      acquire: vi.fn().mockResolvedValue({ id: 'lease', continuation: null }),
      complete: vi.fn().mockResolvedValue(1),
      release: vi.fn(),
    };
    const inventory = { listIntakeObjects: vi.fn().mockResolvedValue(page) };
    const signal = new AbortController().signal;

    await expect(
      new ReconcileIntakeAttachmentObjects(reconciliation, inventory).execute({ signal }),
    ).resolves.toEqual({ requeued: 1 });
    expect(inventory.listIntakeObjects).toHaveBeenCalledWith(null, signal);
    expect(reconciliation.complete).toHaveBeenCalledWith('lease', page);
    expect(reconciliation.release).not.toHaveBeenCalled();
  });

  it('releases a failed inventory attempt without advancing the cursor', async () => {
    const reconciliation = {
      acquire: vi.fn().mockResolvedValue({ id: 'lease', continuation: 'cursor' }),
      complete: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const inventory = { listIntakeObjects: vi.fn().mockRejectedValue(new Error('unavailable')) };

    await expect(
      new ReconcileIntakeAttachmentObjects(reconciliation, inventory).execute({
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('unavailable');
    expect(reconciliation.release).toHaveBeenCalledWith('lease');
    expect(reconciliation.complete).not.toHaveBeenCalled();
  });
});
