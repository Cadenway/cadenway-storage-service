import { describe, expect, it, vi } from 'vitest';

import type { BillingAttachmentUsageCursor } from '../../../../ports/outbound/crypto/billing/billing-attachment-usage-cursor.port.js';
import type { BillingAttachmentUsageReader } from '../../../../ports/outbound/persistence/billing/billing-attachment-usage-reader.port.js';
import { ListBillingAttachmentUsage } from './list-billing-attachment-usage.use-case.js';

const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const first = {
  fileId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f11',
  version: 1,
  state: 'ready',
  sizeBytes: 248320,
} as const;
const second = {
  fileId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f12',
  version: 2,
  state: 'deleted',
} as const;
const upperId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
const position = { upperId, afterId: first.fileId };

describe('ListBillingAttachmentUsage', () => {
  it('refuses unavailable or invalid cursors before reading a tenant snapshot', async () => {
    const reader = { read: vi.fn() } satisfies BillingAttachmentUsageReader;
    const cursor = {
      decode: vi.fn().mockReturnValue(null),
      encode: vi.fn(),
    } satisfies BillingAttachmentUsageCursor;
    const input = { organizationId, cursor: 'invalid', limit: 1 };

    await expect(new ListBillingAttachmentUsage(reader, null).execute(input)).rejects.toMatchObject(
      {
        reason: 'unavailable',
      },
    );
    await expect(
      new ListBillingAttachmentUsage(reader, cursor).execute(input),
    ).rejects.toMatchObject({
      reason: 'invalid-cursor',
    });
    expect(cursor.decode).toHaveBeenCalledExactlyOnceWith(organizationId, 'invalid');
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('fixes the upper ID and seals the last returned ID only when a lookahead exists', async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({ upperId, items: [first, second] }),
    } satisfies BillingAttachmentUsageReader;
    const cursor = {
      decode: vi.fn(),
      encode: vi.fn().mockReturnValue('next'),
    } satisfies BillingAttachmentUsageCursor;
    const useCase = new ListBillingAttachmentUsage(reader, cursor);

    await expect(useCase.execute({ organizationId, cursor: null, limit: 1 })).resolves.toEqual({
      items: [first],
      nextCursor: 'next',
    });
    expect(reader.read).toHaveBeenCalledExactlyOnceWith(organizationId, null, 2);
    expect(cursor.encode).toHaveBeenCalledExactlyOnceWith(organizationId, position);
    expect(cursor.decode).not.toHaveBeenCalled();
  });

  it('decodes a tenant-bound continuation and returns null when the last page is complete', async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({ upperId, items: [second] }),
    } satisfies BillingAttachmentUsageReader;
    const cursor = {
      decode: vi.fn().mockReturnValue(position),
      encode: vi.fn(),
    } satisfies BillingAttachmentUsageCursor;

    await expect(
      new ListBillingAttachmentUsage(reader, cursor).execute({
        organizationId,
        cursor: 'next',
        limit: 1,
      }),
    ).resolves.toEqual({ items: [second], nextCursor: null });
    expect(reader.read).toHaveBeenCalledExactlyOnceWith(organizationId, position, 2);
    expect(cursor.encode).not.toHaveBeenCalled();
  });

  it.each([0, 101, 1.5])('rejects an invalid page size %s before reading', async (limit) => {
    const reader = { read: vi.fn() } satisfies BillingAttachmentUsageReader;
    const cursor = { decode: vi.fn(), encode: vi.fn() } satisfies BillingAttachmentUsageCursor;

    await expect(
      new ListBillingAttachmentUsage(reader, cursor).execute({
        organizationId,
        cursor: null,
        limit,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('fails closed if an inconsistent reader reports a continuation without an upper bound', async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({ upperId: null, items: [first, second] }),
    } satisfies BillingAttachmentUsageReader;
    const cursor = { decode: vi.fn(), encode: vi.fn() } satisfies BillingAttachmentUsageCursor;

    await expect(
      new ListBillingAttachmentUsage(reader, cursor).execute({
        organizationId,
        cursor: null,
        limit: 1,
      }),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    expect(cursor.encode).not.toHaveBeenCalled();
  });
});
