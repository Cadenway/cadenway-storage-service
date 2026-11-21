import { z } from 'zod';

const keyId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u);
const keyMaterial = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u)
  .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value);
const keyring = z
  .strictObject({
    activeKeyId: keyId,
    keys: z
      .array(z.strictObject({ id: keyId, key: keyMaterial }))
      .min(1)
      .max(4),
  })
  .refine(({ activeKeyId, keys }) => {
    const ids = new Set(keys.map(({ id }) => id));
    return ids.size === keys.length && ids.has(activeKeyId);
  });

/** Read-only receipt key material for one active writer and retained decryption keys. */
export interface UploadReceiptKeyring {
  // #region Properties
  /** Selects the key for new receipts. */
  readonly activeKeyId: string;

  /** Identifies up to four canonical base64url AES-256 keys. */
  readonly keys: readonly { readonly id: string; readonly key: string }[];
  // #endregion
}

/** Parses bounded keyring JSON and reports malformed values without quoting key material. */
export const uploadReceiptKeyringSchema: z.ZodType<UploadReceiptKeyring> = z
  .string()
  .max(1024, 'The upload receipt keyring must be at most 1024 characters.')
  .transform((value, context) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      decoded = null;
    }
    const result = keyring.safeParse(decoded);
    if (!result.success) {
      context.addIssue({
        code: 'custom',
        message: 'Expected one active ID and up to four labeled base64url AES-256 keys.',
      });
      return z.NEVER;
    }
    return result.data;
  });
