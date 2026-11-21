import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { z } from 'zod';

import type { UploadCapability } from '../../../application/models/attachment/upload-capability.model.js';
import { AttachmentObjectStorageError } from '../../../application/ports/outbound/object-storage/attachment/attachment-object-store.port.js';

interface ReceiptBinding {
  // #region Properties
  /** Verified tenant and actor, canonicalized as PostgreSQL UUIDs. */
  readonly organizationId: string;
  readonly actorId: string;

  /** Stable task key, hashed idempotency key and request fingerprint. */
  readonly taskKey: string;
  readonly keyDigest: string;
  readonly fingerprint: string;

  /** Exclusive replay expiration, independent of the signed capability expiration. */
  readonly expiresAt: Date;
  // #endregion
}

interface SealedReceipt {
  // #region Properties
  /** Selects the retained decryption key. */
  readonly keyId: string;

  /** AES-GCM nonce, encrypted serialized response and authentication tag. */
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
  // #endregion
}

interface Keyring {
  // #region Properties
  /** Selects the key used by new writes. */
  readonly activeKeyId: string;

  /** Contains canonical base64url AES-256 key material. */
  readonly keys: readonly { readonly id: string; readonly key: string }[];
  // #endregion
}

const nonceBytes = 12;
const authTagBytes = 16;
const uploadCapability = z.strictObject({
  id: z.uuid(),
  method: z.literal('POST'),
  url: z.url({ protocol: /^https?$/u }),
  fields: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});

/** Authenticates the receipt context, format and rotation key without storing it in the payload. */
function associatedData(binding: ReceiptBinding, keyId: string): Buffer {
  return Buffer.from(
    JSON.stringify([
      'attachment-upload-receipt-v1',
      keyId,
      binding.organizationId.toLowerCase(),
      binding.actorId.toLowerCase(),
      binding.taskKey,
      binding.keyDigest,
      binding.fingerprint,
      binding.expiresAt.toISOString(),
    ]),
  );
}

/** Seals a signed upload receipt before persistence and authenticates it before replay. */
export class UploadReceiptCodec {
  // #region Properties
  /** Selects the encryption key and retains previous keys for replay. */
  private readonly activeKeyId: string;
  private readonly keys: ReadonlyMap<string, KeyObject>;
  // #endregion

  // #region Constructor
  /** Loads the validated rotation keyring into cryptographic key objects. */
  public constructor({ activeKeyId, keys }: Keyring) {
    this.activeKeyId = activeKeyId;
    this.keys = new Map(
      keys.map(({ id, key }) => [id, createSecretKey(Buffer.from(key, 'base64url'))]),
    );
  }
  // #endregion

  // #region Methods
  /** Encrypts an original response with a fresh nonce and its exact receipt context. */
  public seal(response: UploadCapability, binding: ReceiptBinding): SealedReceipt {
    const keyId = this.activeKeyId;
    const key = this.keys.get(keyId);
    if (key === undefined) throw new AttachmentObjectStorageError();
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: authTagBytes });
    cipher.setAAD(associatedData(binding, keyId));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(response), 'utf8'),
      cipher.final(),
    ]);
    return { keyId, nonce, ciphertext, authTag: cipher.getAuthTag() };
  }

  /** Returns only an authenticated response while keeping rejected values out of diagnostics. */
  public open(sealed: SealedReceipt, binding: ReceiptBinding): UploadCapability {
    const key = this.keys.get(sealed.keyId);
    if (key === undefined || sealed.nonce.length !== nonceBytes)
      throw new AttachmentObjectStorageError();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, {
        authTagLength: authTagBytes,
      });
      decipher.setAAD(associatedData(binding, sealed.keyId));
      decipher.setAuthTag(sealed.authTag);
      const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
      const decoded: unknown = JSON.parse(plaintext.toString('utf8'));
      return uploadCapability.parse(decoded);
    } catch {
      throw new AttachmentObjectStorageError();
    }
  }
  // #endregion
}
