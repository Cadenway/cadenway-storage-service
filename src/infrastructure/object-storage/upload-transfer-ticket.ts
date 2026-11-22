import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from 'node:crypto';

import { z } from 'zod';

import type { UploadReceiptKeyring } from '../../config/upload-receipt-keyring.js';

const nonceBytes = 12;
const tagBytes = 16;
const issuerStartedAt = Date.now();
// The local service runs one replica. An epoch prevents a restored database from reopening
// tickets issued before the restore, even if it no longer contains their admission record.
const context = Buffer.concat([Buffer.from('storage-upload-transfer-v1'), randomBytes(32)]);
const tokenPattern = /^([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]{1,512})$/u;
const authorization = z.strictObject({
  key: z.string().min(1).max(128),
  sizeBytes: z.int().positive(),
  contentType: z.string().min(1).max(128),
  expiresAt: z.iso.datetime(),
});

/** Exact staged payload and deadline authenticated by the grant. */
export type UploadTransferAuthorization = Readonly<z.infer<typeof authorization>>;

/** Issues and verifies bounded encrypted tickets without disclosing a direct-write credential. */
export class UploadTransferTicket {
  // #region Properties
  /** Active and retained verification keys. */
  private readonly keys;
  // #endregion

  // #region Constructor
  /** Binds the locally exposed target and the receipt keyring. */
  public constructor(
    private readonly endpoint: string,
    private readonly keyring: UploadReceiptKeyring,
  ) {
    this.keys = new Map(
      keyring.keys.map(({ id, key }) => [id, createSecretKey(Buffer.from(key, 'base64url'))]),
    );
  }
  // #endregion

  // #region Methods
  /** Profile staging IDs are UUIDv7 values allocated by the local owning service. */
  public acceptsProfileUploadId(uploadId: string): boolean {
    const allocatedAt = Number.parseInt(uploadId.slice(0, 8) + uploadId.slice(9, 13), 16);
    return allocatedAt >= issuerStartedAt;
  }

  /** The caller has already checked its Storage namespace, MIME and declared size. */
  public issue(input: UploadTransferAuthorization): {
    readonly method: 'POST';
    readonly url: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  } {
    const key = this.keys.get(this.keyring.activeKeyId);
    if (key === undefined) throw new Error('Missing upload-transfer signing key');
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: tagBytes });
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(input), 'utf8'),
      cipher.final(),
    ]);
    const sealed = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
    return {
      method: 'POST',
      url: this.endpoint,
      fields: { ticket: `${this.keyring.activeKeyId}.${sealed}` },
      expiresAt: input.expiresAt,
    };
  }

  /** Returns only an authenticated declaration and keeps ticket contents out of errors. */
  public open(ticket: string): UploadTransferAuthorization | null {
    const match = tokenPattern.exec(ticket);
    const keyId = match?.[1];
    const sealed = match?.[2];
    if (keyId === undefined || sealed === undefined) return null;
    const key = this.keys.get(keyId);
    if (key === undefined) return null;
    const bytes = Buffer.from(sealed, 'base64url');
    if (bytes.length <= nonceBytes + tagBytes || bytes.toString('base64url') !== sealed)
      return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, nonceBytes), {
        authTagLength: tagBytes,
      });
      decipher.setAAD(context);
      decipher.setAuthTag(bytes.subarray(nonceBytes, nonceBytes + tagBytes));
      const plaintext = Buffer.concat([
        decipher.update(bytes.subarray(nonceBytes + tagBytes)),
        decipher.final(),
      ]);
      return authorization.parse(JSON.parse(plaintext.toString('utf8')));
    } catch {
      return null;
    }
  }
  // #endregion
}

/** Leaves time for an interrupted S3 request to settle before staging erasure. */
export function stagingTransferCleanupAfter(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() + 15_000);
}
