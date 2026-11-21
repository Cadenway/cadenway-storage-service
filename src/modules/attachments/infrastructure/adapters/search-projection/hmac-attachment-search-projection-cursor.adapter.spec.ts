import { describe, expect, it } from 'vitest';

import { HmacAttachmentProjectionCursor } from '../projection-cursor/hmac-attachment-projection-cursor.adapter.js';
import { HmacAttachmentSearchProjectionCursor } from './hmac-attachment-search-projection-cursor.adapter.js';

const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const otherOrganizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e11';
const position = {
  upperFileId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15',
  afterFileId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f11',
};

describe('HmacAttachmentSearchProjectionCursor', () => {
  it('keeps existing Search cursors readable and distinct from Billing cursors', () => {
    const fixture =
      'v1.MDE5YTcwMDQtM2IyYy03ZDRlLThmNWEtNmI3YzhkOWUwZjE1OjAxOWE3MDA0LTNiMmMtN2Q0ZS04ZjVhLTZiN2M4ZDllMGYxMQ.E2MwLhMsa9sgji1SsPLwOxV3UTM8zTz_FFGlKBb-tnw';
    const key = Buffer.alloc(32, 3);
    const search = new HmacAttachmentSearchProjectionCursor(key);
    const billing = new HmacAttachmentProjectionCursor(key, 'billing');
    const billingPosition = { upperId: position.upperFileId, afterId: position.afterFileId };
    const billingCursor = billing.encode(organizationId, billingPosition);

    expect(search.encode(organizationId, position)).toBe(fixture);
    expect(search.decode(organizationId, fixture)).toEqual(position);
    expect(billing.decode(organizationId, billingCursor)).toEqual(billingPosition);
    expect(billing.decode(otherOrganizationId, billingCursor)).toBeNull();
    expect(billing.decode(organizationId, fixture)).toBeNull();
    expect(search.decode(organizationId, billingCursor)).toBeNull();
  });

  it('keeps continuations stable across adapter instances with the same key', () => {
    const key = Buffer.alloc(32, 3);
    const writer = new HmacAttachmentSearchProjectionCursor(key);
    const reader = new HmacAttachmentSearchProjectionCursor(key);
    key.fill(0);

    const cursor = writer.encode(organizationId.toUpperCase(), {
      upperFileId: position.upperFileId.toUpperCase(),
      afterFileId: position.afterFileId,
    });

    expect(reader.decode(organizationId, cursor)).toEqual(position);
    expect(reader.encode(organizationId, position)).toBe(cursor);
  });

  it('rejects another tenant, a rotated key, and a changed fence or position', () => {
    const codec = new HmacAttachmentSearchProjectionCursor(Buffer.alloc(32, 3));
    const rotated = new HmacAttachmentSearchProjectionCursor(Buffer.alloc(32, 4));
    const cursor = codec.encode(organizationId, position);
    const changedFence = codec.encode(organizationId, {
      ...position,
      upperFileId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f16',
    });
    const changedPosition = codec.encode(organizationId, {
      ...position,
      afterFileId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f12',
    });
    const signature = cursor.split('.').at(-1);

    expect(codec.decode(otherOrganizationId, cursor)).toBeNull();
    expect(rotated.decode(organizationId, cursor)).toBeNull();
    for (const replacement of [changedFence, changedPosition]) {
      const forged = replacement.replace(/[^.]+$/u, String(signature));
      expect(codec.decode(organizationId, forged)).toBeNull();
    }
  });

  it('refuses malformed continuations and out-of-order repository positions', () => {
    const codec = new HmacAttachmentSearchProjectionCursor(Buffer.alloc(32, 3));
    expect(codec.decode(organizationId, '')).toBeNull();
    expect(codec.decode(organizationId, 'v1.invalid.invalid')).toBeNull();
    expect(() =>
      codec.encode(organizationId, { ...position, afterFileId: position.upperFileId }),
    ).toThrow('Attachment Search cursor position is invalid.');
    expect(() => new HmacAttachmentSearchProjectionCursor(Buffer.alloc(16))).toThrow(
      'The attachment Search cursor key must be 32 bytes.',
    );
  });
});
