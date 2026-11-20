import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';

import type { ProfileMediaReceiptCipher } from '../../persistence/drizzle/repositories/media/drizzle-profile-media-transaction.repository.js';

type ProfileMediaCapability = ReturnType<ProfileMediaReceiptCipher['open']>;

const response = z.strictObject({
  uploadId: z.uuid(),
  method: z.literal('POST'),
  url: z.url({ protocol: /^https?$/u }),
  fields: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});

/** Encrypts signed receipts with AES-GCM and authenticates the owner, declaration and retention. */
export class AesProfileMediaReceiptCipher implements ProfileMediaReceiptCipher {
  // #region Properties
  /** Keyring retained for receipt decryption during key rotation. */
  private readonly keys: ReadonlyMap<string, KeyObject>;
  // #endregion

  // #region Constructor
  /** Receives the existing service keyring; key material is never written to persistence. */
  public constructor(
    private readonly activeKeyId: string,
    keys: readonly { readonly id: string; readonly key: string }[],
  ) {
    this.keys = new Map(
      keys.map(({ id, key }) => [id, createSecretKey(Buffer.from(key, 'base64url'))]),
    );
  }
  // #endregion

  // #region Methods
  /** Seals a complete signed capability and its immutable binding. */
  public seal(
    capability: ProfileMediaCapability,
    binding: string,
  ): {
    readonly keyId: string;
    readonly nonce: Buffer;
    readonly ciphertext: Buffer;
    readonly authTag: Buffer;
  } {
    const key = this.keys.get(this.activeKeyId);
    if (key === undefined) throw new Error('Profile receipt encryption unavailable.');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([this.activeKeyId, binding])));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(capability), 'utf8'),
      cipher.final(),
    ]);
    return { keyId: this.activeKeyId, nonce, ciphertext, authTag: cipher.getAuthTag() };
  }

  /** Authenticates a stored capability before returning it to an authorized caller. */
  public open(
    sealed: {
      readonly keyId: string;
      readonly nonce: Buffer;
      readonly ciphertext: Buffer;
      readonly authTag: Buffer;
    },
    binding: string,
  ): ProfileMediaCapability {
    const key = this.keys.get(sealed.keyId);
    if (key === undefined || sealed.nonce.length !== 12 || sealed.authTag.length !== 16)
      throw new Error('Profile receipt decryption unavailable.');
    try {
      const cipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
      cipher.setAAD(Buffer.from(JSON.stringify([sealed.keyId, binding])));
      cipher.setAuthTag(sealed.authTag);
      const bytes = Buffer.concat([cipher.update(sealed.ciphertext), cipher.final()]);
      return response.parse(JSON.parse(bytes.toString('utf8')) as unknown);
    } catch {
      throw new Error('Profile receipt decryption unavailable.');
    }
  }
  // #endregion
}
