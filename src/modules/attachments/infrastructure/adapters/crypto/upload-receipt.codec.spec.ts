import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { UploadCapability } from '../../../application/models/attachment/upload-capability.model.js';
import { AttachmentObjectStorageError } from '../../../application/ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import { UploadReceiptCodec } from './upload-receipt.codec.js';

const response: UploadCapability = {
  id: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15',
  method: 'POST',
  url: 'https://files.example.test/atelier-nord',
  fields: { key: 'org/fixture/attachment', policy: 'synthetic-upload-policy' },
  expiresAt: '2026-11-08T08:05:00.000Z',
};
const binding = {
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  taskKey: 'CAD-482',
  keyDigest: 'a'.repeat(64),
  fingerprint: 'b'.repeat(64),
  expiresAt: new Date('2026-11-09T08:00:00.123Z'),
};

function key(id: string): { readonly id: string; readonly key: string } {
  return { id, key: randomBytes(32).toString('base64url') };
}

describe('UploadReceiptCodec', () => {
  it('stores only ciphertext and restores the exact original capability', () => {
    const codec = new UploadReceiptCodec({ activeKeyId: 'current', keys: [key('current')] });
    const first = codec.seal(response, binding);
    const second = codec.seal(response, binding);

    expect(first.keyId).toBe('current');
    expect(first.nonce).toHaveLength(12);
    expect(first.authTag).toHaveLength(16);
    expect(first.nonce).not.toEqual(second.nonce);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(first.ciphertext.includes(Buffer.from(response.url))).toBe(false);
    expect(first.ciphertext.includes(Buffer.from(response.fields.policy ?? ''))).toBe(false);
    expect(codec.open(first, binding)).toEqual(response);
  });

  it('preserves older receipts on rotation while sealing only with the active key', () => {
    const previous = key('previous');
    const current = key('current');
    const oldCodec = new UploadReceiptCodec({ activeKeyId: 'previous', keys: [previous] });
    const oldReceipt = oldCodec.seal(response, binding);
    const codec = new UploadReceiptCodec({
      activeKeyId: 'current',
      keys: [previous, current],
    });

    expect(codec.open(oldReceipt, binding)).toEqual(response);
    expect(codec.seal(response, binding).keyId).toBe('current');
    const afterExpiry = new UploadReceiptCodec({ activeKeyId: 'current', keys: [current] });
    expect(() => afterExpiry.open(oldReceipt, binding)).toThrow(AttachmentObjectStorageError);
  });

  it('authenticates every field in the tenant-bound replay context', () => {
    const codec = new UploadReceiptCodec({ activeKeyId: 'current', keys: [key('current')] });
    const sealed = codec.seal(response, binding);

    expect(codec.open(sealed, { ...binding, actorId: binding.actorId.toUpperCase() })).toEqual(
      response,
    );
    for (const changedScope of [
      { organizationId: binding.actorId },
      { actorId: binding.organizationId },
      { taskKey: 'CAD-483' },
      { keyDigest: binding.fingerprint },
      { fingerprint: binding.keyDigest },
      { expiresAt: new Date('2026-11-09T08:00:00.124Z') },
    ]) {
      expect(() => codec.open(sealed, { ...binding, ...changedScope })).toThrow(
        AttachmentObjectStorageError,
      );
    }
  });

  it('fails closed on corrupted ciphertext with a sanitized error', () => {
    const codec = new UploadReceiptCodec({ activeKeyId: 'current', keys: [key('current')] });
    const sealed = codec.seal(response, binding);
    const corrupted = { ...sealed, ciphertext: sealed.ciphertext.subarray(1) };

    expect(() => codec.open(corrupted, binding)).toThrow(AttachmentObjectStorageError);
    expect(() => codec.open(corrupted, binding)).not.toThrow(/synthetic-upload-policy/u);
  });
});
