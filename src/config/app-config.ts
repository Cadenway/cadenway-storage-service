import { baseConfigShape, internalTokenVerifierConfigShape } from '@cadenway/nest-common';
import type { BaseConfig, InternalTokenVerifierConfig } from '@cadenway/nest-common';
import { databaseConfigShape } from '@cadenway/nest-common/database';
import type { DatabaseConfig } from '@cadenway/nest-common/database';
import { messagingConfigShape } from '@cadenway/nest-messaging';
import type { MessagingConfig } from '@cadenway/nest-messaging';
import { z } from 'zod';

import { uploadReceiptKeyringSchema } from './upload-receipt-keyring.js';

const storageEndpoint = z
  .url({ protocol: /^https?$/u, error: 'Expected an HTTP or HTTPS object storage endpoint.' })
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  }, 'Object storage endpoints cannot contain credentials, queries or fragments.');

const storageValue = z
  .string()
  .refine((value) => value.trim().length > 0, 'Expected a non-empty object storage setting.');

const objectStorageInput = z.object({
  S3_ENDPOINT: storageEndpoint,
  S3_PUBLIC_ENDPOINT: storageEndpoint,
  S3_REGION: storageValue,
  S3_BUCKET: storageValue,
  S3_ACCESS_KEY_ID: storageValue,
  S3_SECRET_ACCESS_KEY: storageValue,
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional(),
  STORAGE_UPLOAD_RECEIPT_KEYS: z.string(),
});

const optionalObjectStorage = objectStorageInput.partial().transform((input, context) => {
  if (Object.keys(input).length === 0) return {};

  const result = objectStorageInput.safeParse(input);
  if (!result.success) {
    for (const { path, message } of result.error.issues) {
      context.addIssue({ code: 'custom', path, message });
    }
    return z.NEVER;
  }

  const receiptKeys = uploadReceiptKeyringSchema.safeParse(result.data.STORAGE_UPLOAD_RECEIPT_KEYS);
  if (!receiptKeys.success) {
    for (const { message } of receiptKeys.error.issues) {
      context.addIssue({ code: 'custom', path: ['STORAGE_UPLOAD_RECEIPT_KEYS'], message });
    }
    return z.NEVER;
  }

  return {
    objectStorage: Object.freeze({
      endpoint: result.data.S3_ENDPOINT,
      publicEndpoint: result.data.S3_PUBLIC_ENDPOINT,
      region: result.data.S3_REGION,
      bucket: result.data.S3_BUCKET,
      accessKeyId: result.data.S3_ACCESS_KEY_ID,
      secretAccessKey: result.data.S3_SECRET_ACCESS_KEY,
      forcePathStyle: result.data.S3_FORCE_PATH_STYLE === 'true',
      receiptKeys: receiptKeys.data,
    }),
  };
});

/**
 * Type AppConfig
 *
 * @description
 * Variables the running service reads, validated when the application is created: by `loadConfig`
 * in `main.ts` for the options of `createApplication`, and by `ConfigModule` for the providers that
 * inject `CONFIG`.
 *
 * - `NODE_ENV`, `PORT`, `LOG_LEVEL`, `LOG_PRETTY`: `baseConfigShape` of `@cadenway/nest-common`;
 *   `PORT` is required, the others default to `production`, `info` and `false`.
 * - `DATABASE_URL`: the application role of this service's own database (`storage_app`), subject to
 *   row-level security and holding no DDL right.
 * - `DATABASE_TRANSACTION_MAX_ATTEMPTS`: total attempts for an outer PostgreSQL transaction.
 *   Defaults to 3. Set it to 1 to disable automatic retries.
 * - `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`: `messagingConfigShape` of `@cadenway/nest-messaging`.
 *   `NATS_URL` is required; the user (`storage`) and its password are optional for the kit, which
 *   accepts an anonymous local broker, but every broker of Cadenway refuses a connection without
 *   them.
 * - `INTERNAL_TOKEN_AUDIENCE` and `INTERNAL_TOKEN_TRUSTED_ISSUERS`: the `aud` this service accepts
 *   and the public keys of the backends allowed to call it.
 *
 * - `S3_*`: internal and browser-facing endpoints, bucket, region and credentials are required
 *   together with `STORAGE_UPLOAD_RECEIPT_KEYS` when object storage is configured.
 *   `S3_FORCE_PATH_STYLE` defaults to false.
 *   Without any storage settings, the service runs with signed transfers unavailable.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is read by `telemetry.ts` before the application exists.
 */
export type AppConfig = BaseConfig &
  DatabaseConfig &
  MessagingConfig &
  InternalTokenVerifierConfig &
  z.output<typeof optionalObjectStorage>;

/**
 * Constant appConfigSchema
 *
 * @description
 * Zod schema of `AppConfig`, composed from the shapes of `@cadenway/nest-common` and
 * `@cadenway/nest-messaging` so the names, defaults and validation stay those of the kit. A missing
 * or invalid variable makes `loadConfig` throw a `ConfigError` that names it without printing its
 * value.
 *
 * @type {z.ZodType<AppConfig>}
 */
export const appConfigSchema: z.ZodType<AppConfig> = z.intersection(
  z.object({
    ...baseConfigShape,
    ...databaseConfigShape,
    ...messagingConfigShape,
    ...internalTokenVerifierConfigShape,
  }),
  optionalObjectStorage,
);

/**
 * Interface MigrationConfig
 *
 * @description
 * Variable the one-off migration container reads (`node dist/migrate.js`). The running service
 * never reads it: only the migrator role may change the structure of the database.
 */
export interface MigrationConfig {
  // #region Properties
  /**
   * Property MIGRATION_DATABASE_URL
   *
   * @description
   * Connection string of the migrator role (`storage_migrator`), which owns the tables and runs the
   * DDL. A secret; cadenway-ops passes it from `STORAGE_SERVICE_MIGRATION_DATABASE_URL`.
   *
   * @type {string}
   * @readonly
   */
  readonly MIGRATION_DATABASE_URL: string;
  // #endregion
}

/**
 * Constant migrationConfigSchema
 *
 * @description
 * Zod schema of `MigrationConfig`: a `postgres://` or `postgresql://` URL, like `DATABASE_URL`.
 *
 * @type {z.ZodType<MigrationConfig>}
 */
export const migrationConfigSchema: z.ZodType<MigrationConfig> = z.object({
  MIGRATION_DATABASE_URL: z.url({
    protocol: /^postgres(?:ql)?$/u,
    error: 'Expected the postgres:// URL of the migrator role.',
  }),
});
