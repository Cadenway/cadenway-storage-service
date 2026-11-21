import { describe, expect, it, vi } from 'vitest';

import type { AttachmentSearchProjectionCursor } from '../../../../ports/outbound/crypto/search-projection/attachment-search-projection-cursor.port.js';
import type { AttachmentSearchProjectionReader } from '../../../../ports/outbound/persistence/search-projection/attachment-search-projection-reader.port.js';
import { ListAttachmentSearchProjections } from './list-attachment-search-projections.use-case.js';

const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const input = { organizationId, limit: 1, cursor: 'opaque' };
const position = {
  upperFileId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15',
  afterFileId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f11',
};

describe('ListAttachmentSearchProjections', () => {
  it('refuses requests before opening a snapshot when the key or continuation is invalid', async () => {
    const reader = { list: vi.fn(), resolve: vi.fn() } satisfies AttachmentSearchProjectionReader;
    const cursor = {
      decode: vi.fn().mockReturnValue(null),
      encode: vi.fn(),
    } satisfies AttachmentSearchProjectionCursor;

    await expect(
      new ListAttachmentSearchProjections(reader, null).execute(input),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(
      new ListAttachmentSearchProjections(reader, cursor).execute(input),
    ).rejects.toMatchObject({ reason: 'invalid-cursor' });
    expect(cursor.decode).toHaveBeenCalledExactlyOnceWith(organizationId, input.cursor);
    expect(reader.list).not.toHaveBeenCalled();
  });

  it('passes only the authenticated position and seals the reader continuation', async () => {
    const reader = {
      list: vi.fn().mockResolvedValue({ items: [], nextPosition: position }),
      resolve: vi.fn(),
    } satisfies AttachmentSearchProjectionReader;
    const cursor = {
      decode: vi.fn().mockReturnValue(position),
      encode: vi.fn().mockReturnValue('successor'),
    } satisfies AttachmentSearchProjectionCursor;
    const execute = new ListAttachmentSearchProjections(reader, cursor);

    await expect(execute.execute(input)).resolves.toEqual({ items: [], nextCursor: 'successor' });
    expect(reader.list).toHaveBeenCalledExactlyOnceWith({ organizationId, position, limit: 1 });
    expect(cursor.encode).toHaveBeenCalledExactlyOnceWith(organizationId, position);
  });
});
