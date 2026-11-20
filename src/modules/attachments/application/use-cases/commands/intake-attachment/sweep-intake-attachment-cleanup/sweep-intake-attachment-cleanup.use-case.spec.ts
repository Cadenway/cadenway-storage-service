import { describe, expect, it, vi } from 'vitest';

import { SweepIntakeAttachmentCleanup } from './sweep-intake-attachment-cleanup.use-case.js';

describe('SweepIntakeAttachmentCleanup', () => {
  it('continues through pages and tenants after an isolated failure', async () => {
    const cutoff = new Date('2026-11-20T10:00:00.000Z');
    const cursor = { cleanupAfter: cutoff, objectKey: 'intake/last' };
    const listDueObjectOrganizations = vi
      .fn()
      .mockResolvedValueOnce(['a', 'b'])
      .mockResolvedValueOnce([]);
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('tenant unavailable'))
      .mockResolvedValueOnce({ processed: 1, failed: 1, next: cursor })
      .mockResolvedValueOnce({ processed: 2, failed: 0, next: null });
    const visited = vi.fn<(organizationId: string) => void>();
    const inOrganization = async <T>(
      organizationId: string,
      work: () => Promise<T>,
    ): Promise<T> => {
      visited(organizationId);
      return work();
    };

    const result = await new SweepIntakeAttachmentCleanup(
      { listDueObjectOrganizations },
      { execute },
    ).execute({
      cutoff,
      signal: new AbortController().signal,
      inOrganization,
    });

    expect(result).toEqual({ attachments: 0, objects: 3, failures: 2 });
    expect(visited.mock.calls.map(([organizationId]) => organizationId)).toEqual(['a', 'b', 'b']);
    expect(execute.mock.calls[2]?.[0]).toMatchObject({ organizationId: 'b', after: cursor });
    expect(listDueObjectOrganizations).toHaveBeenLastCalledWith(cutoff, 'b');
  });
});
