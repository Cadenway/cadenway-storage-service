import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AesProfileMediaReceiptCipher } from './aes-profile-media-receipt-cipher.adapter.js';

describe('profile media receipt encryption', () => {
  it('returns the original capability only for its authenticated owner binding', () => {
    const cipher = new AesProfileMediaReceiptCipher('test', [
      { id: 'test', key: randomBytes(32).toString('base64url') },
    ]);
    const capability = {
      uploadId: '01954f00-0000-7000-8000-000000000001',
      method: 'POST' as const,
      url: 'https://storage.example.test/upload',
      fields: { key: 'opaque' },
      expiresAt: '2026-11-20T12:00:00.000Z',
    };
    const sealed = cipher.seal(capability, 'owner-and-declaration');
    expect(cipher.open(sealed, 'owner-and-declaration')).toEqual(capability);
    expect(() => cipher.open(sealed, 'different-owner')).toThrow();
    expect(() =>
      cipher.open(
        { ...sealed, ciphertext: Buffer.concat([sealed.ciphertext, Buffer.from([0])]) },
        'owner-and-declaration',
      ),
    ).toThrow();
  });
});
