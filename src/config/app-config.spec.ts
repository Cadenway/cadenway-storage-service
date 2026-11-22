import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

import { ConfigError, loadConfig } from '@cadenway/nest-common';
import { describe, expect, it } from 'vitest';

import { appConfigSchema, migrationConfigSchema } from './app-config.js';

describe('appConfigSchema', () => {
  const trustedIssuers: string =
    '{"api-gateway":[{"kty":"OKP","crv":"Ed25519","x":"MVZQc5h6AXxnMpaBTaYw5kI-yWWawl6zp8Srhuf5NK0","kid":"local-placeholder"}]}';
  const complete: Readonly<Record<string, string>> = {
    PORT: '3015',
    DATABASE_URL: 'postgres://storage_app:storage_app@localhost:5432/storage',
    NATS_URL: 'nats://localhost:4222',
    NATS_USER: 'storage',
    NATS_PASSWORD: 'storage',
    INTERNAL_TOKEN_AUDIENCE: 'storage-service',
    INTERNAL_TOKEN_TRUSTED_ISSUERS: trustedIssuers,
  };
  const searchKeys = ['search-current', 'search-previous'].map((kid) => ({
    kty: 'OKP',
    crv: 'Ed25519',
    x: randomBytes(32).toString('base64url'),
    kid,
  }));
  const billingKey = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: randomBytes(32).toString('base64url'),
    kid: 'billing-current',
  };
  const objectStorage: Readonly<Record<string, string>> = {
    S3_ENDPOINT: 'http://garage:3900',
    S3_PUBLIC_ENDPOINT: 'https://files.example.test',
    S3_REGION: 'garage',
    S3_BUCKET: 'storage-test',
    S3_ACCESS_KEY_ID: 'fixture-key',
    S3_SECRET_ACCESS_KEY: 'fixture-placeholder',
  };
  const receiptKeys = {
    activeKeyId: 'current',
    keys: [
      { id: 'current', key: randomBytes(32).toString('base64url') },
      { id: 'previous', key: randomBytes(32).toString('base64url') },
    ],
  };
  const configuredStorage = {
    ...objectStorage,
    STORAGE_UPLOAD_RECEIPT_KEYS: JSON.stringify(receiptKeys),
  };

  it('reads the variables of the service with the defaults of the kit', () => {
    expect(loadConfig(appConfigSchema, complete)).toEqual({
      NODE_ENV: 'production',
      PORT: 3015,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
      DATABASE_URL: 'postgres://storage_app:storage_app@localhost:5432/storage',
      DATABASE_TRANSACTION_MAX_ATTEMPTS: 3,
      NATS_URL: 'nats://localhost:4222',
      NATS_USER: 'storage',
      NATS_PASSWORD: 'storage',
      STORAGE_BYTE_QUOTA_ENABLED: false,
      STORAGE_BILLING_ENTITLEMENTS_ENABLED: false,
      INTERNAL_TOKEN_AUDIENCE: 'storage-service',
      INTERNAL_TOKEN_TRUSTED_ISSUERS: {
        'api-gateway': [
          {
            kty: 'OKP',
            crv: 'Ed25519',
            x: 'MVZQc5h6AXxnMpaBTaYw5kI-yWWawl6zp8Srhuf5NK0',
            kid: 'local-placeholder',
          },
        ],
      },
    });
  });

  it('accepts the committed .env.example as it is', () => {
    const example: NodeJS.Dict<string> = parseEnv(
      readFileSync(new URL('../../.env.example', import.meta.url), 'utf8'),
    );

    expect(() => loadConfig(appConfigSchema, example)).not.toThrow();
    expect(() => loadConfig(migrationConfigSchema, example)).not.toThrow();
  });

  it('keeps export settings optional when staged deployment passes empty variables', () => {
    expect(
      loadConfig(appConfigSchema, {
        ...complete,
        SEARCH_SERVICE_INTERNAL_TOKEN_PUBLIC_JWKS: '',
        SEARCH_PROJECTION_CURSOR_SECRET: '',
        BILLING_SERVICE_INTERNAL_TOKEN_PUBLIC_JWKS: '',
        BILLING_PROJECTION_CURSOR_SECRET: '',
      }),
    ).toStrictEqual(loadConfig(appConfigSchema, complete));
  });

  it('adds the optional Search key list without replacing another issuer', () => {
    const expected = loadConfig(appConfigSchema, complete);
    const config = loadConfig(appConfigSchema, {
      ...complete,
      SEARCH_SERVICE_INTERNAL_TOKEN_PUBLIC_JWKS: searchKeys
        .map((key) => JSON.stringify(key))
        .join(','),
    });

    expect(config.INTERNAL_TOKEN_TRUSTED_ISSUERS).toEqual({
      ...expected.INTERNAL_TOKEN_TRUSTED_ISSUERS,
      'search-service': searchKeys,
    });
    expect(config).not.toHaveProperty('SEARCH_SERVICE_INTERNAL_TOKEN_PUBLIC_JWKS');
  });

  it('uses the explicit Search keys without reading the fallback list', () => {
    const expected = {
      ...loadConfig(appConfigSchema, complete).INTERNAL_TOKEN_TRUSTED_ISSUERS,
      'search-service': searchKeys,
    };
    const config = loadConfig(appConfigSchema, {
      ...complete,
      INTERNAL_TOKEN_TRUSTED_ISSUERS: JSON.stringify(expected),
      SEARCH_SERVICE_INTERNAL_TOKEN_PUBLIC_JWKS: 'obsolete-fallback',
    });

    expect(config.INTERNAL_TOKEN_TRUSTED_ISSUERS).toEqual(expected);
  });

  it('combines both issuer fallbacks and honors the explicit Billing trust map', () => {
    const input = {
      ...complete,
      SEARCH_SERVICE_INTERNAL_TOKEN_PUBLIC_JWKS: searchKeys
        .map((key) => JSON.stringify(key))
        .join(','),
      BILLING_SERVICE_INTERNAL_TOKEN_PUBLIC_JWKS: JSON.stringify(billingKey),
      BILLING_PROJECTION_CURSOR_SECRET: randomBytes(32).toString('base64url'),
    };
    const config = loadConfig(appConfigSchema, input);
    expect(config.INTERNAL_TOKEN_TRUSTED_ISSUERS).toEqual({
      ...loadConfig(appConfigSchema, complete).INTERNAL_TOKEN_TRUSTED_ISSUERS,
      'search-service': searchKeys,
      'billing-service': [billingKey],
    });
    expect(config.BILLING_PROJECTION_CURSOR_SECRET).toBe(input.BILLING_PROJECTION_CURSOR_SECRET);
    expect(config).not.toHaveProperty('BILLING_SERVICE_INTERNAL_TOKEN_PUBLIC_JWKS');

    const explicit = loadConfig(appConfigSchema, {
      ...input,
      INTERNAL_TOKEN_TRUSTED_ISSUERS: JSON.stringify(config.INTERNAL_TOKEN_TRUSTED_ISSUERS),
      BILLING_SERVICE_INTERNAL_TOKEN_PUBLIC_JWKS: 'obsolete-fallback',
    });
    expect(explicit.INTERNAL_TOKEN_TRUSTED_ISSUERS).toEqual(config.INTERNAL_TOKEN_TRUSTED_ISSUERS);
  });

  it('reports invalid Billing settings without exposing their values', () => {
    for (const setting of [
      'BILLING_SERVICE_INTERNAL_TOKEN_PUBLIC_JWKS',
      'BILLING_PROJECTION_CURSOR_SECRET',
    ]) {
      const input = { ...complete, [setting]: 'fixture-sensitive-value' };
      expect(() => loadConfig(appConfigSchema, input)).toThrow(setting);
      expect(() => loadConfig(appConfigSchema, input)).not.toThrow(/fixture-sensitive-value/u);
    }
  });

  it('refuses malformed or private Search fallback keys without echoing the supplied value', () => {
    for (const value of [
      'fixture-sensitive-value',
      JSON.stringify({ ...searchKeys[0], d: 'fixture-sensitive-value' }),
    ]) {
      const environment = { ...complete, SEARCH_SERVICE_INTERNAL_TOKEN_PUBLIC_JWKS: value };

      expect(() => loadConfig(appConfigSchema, environment)).toThrow(
        /SEARCH_SERVICE_INTERNAL_TOKEN_PUBLIC_JWKS:/u,
      );
      expect(() => loadConfig(appConfigSchema, environment)).not.toThrow(
        /fixture-sensitive-value/u,
      );
    }
  });

  it('accepts a canonical cursor key and rejects a different spelling of the same bytes', () => {
    const value = randomBytes(32).toString('base64url');
    expect(
      loadConfig(appConfigSchema, { ...complete, SEARCH_PROJECTION_CURSOR_SECRET: value })
        .SEARCH_PROJECTION_CURSOR_SECRET,
    ).toBe(value);

    for (const invalid of [`${value}=`, `${'A'.repeat(42)}B`, 'fixture-sensitive-value']) {
      const environment = { ...complete, SEARCH_PROJECTION_CURSOR_SECRET: invalid };

      expect(() => loadConfig(appConfigSchema, environment)).toThrow(
        /SEARCH_PROJECTION_CURSOR_SECRET:/u,
      );
      expect(() => loadConfig(appConfigSchema, environment)).not.toThrow(
        /fixture-sensitive-value/u,
      );
    }
  });

  it('validates both object storage endpoints and keeps path-style addressing opt-in', () => {
    const config = loadConfig(appConfigSchema, { ...complete, ...configuredStorage });
    expect(config.objectStorage).toMatchObject({
      endpoint: 'http://garage:3900',
      publicEndpoint: 'https://files.example.test',
      bucket: 'storage-test',
      forcePathStyle: false,
      eraseTransientVersions: false,
      receiptKeys,
    });
    expect(
      loadConfig(appConfigSchema, {
        ...complete,
        ...configuredStorage,
        S3_FORCE_PATH_STYLE: 'true',
      }).objectStorage?.forcePathStyle,
    ).toBe(true);
  });

  it('requires an explicit versioned-bucket opt-in for permanent transient erasure', () => {
    const config = {
      ...complete,
      ...configuredStorage,
      S3_ERASE_TRANSIENT_VERSIONS: 'true',
    };
    expect(loadConfig(appConfigSchema, config).objectStorage?.eraseTransientVersions).toBe(true);
    expect(() =>
      loadConfig(appConfigSchema, { ...config, S3_ERASE_TRANSIENT_VERSIONS: 'yes' }),
    ).toThrow(/S3_ERASE_TRANSIENT_VERSIONS:/u);
  });

  it('only enables the local upload transfer path on a configured loopback host', () => {
    const config = { ...complete, ...configuredStorage };
    const local = 'http://s3.cadenway.localhost/internal/v1/upload-transfers';
    expect(
      loadConfig(appConfigSchema, { ...config, STORAGE_UPLOAD_TRANSFER_URL: '' }).objectStorage
        ?.uploadTransferUrl,
    ).toBeUndefined();
    expect(
      loadConfig(appConfigSchema, { ...config, STORAGE_UPLOAD_TRANSFER_URL: local }).objectStorage
        ?.uploadTransferUrl,
    ).toBe(local);
    for (const invalid of [
      'https://s3.example.test/internal/v1/upload-transfers',
      'http://127.0.0.1/wrong-path',
    ]) {
      expect(() =>
        loadConfig(appConfigSchema, { ...config, STORAGE_UPLOAD_TRANSFER_URL: invalid }),
      ).toThrow(/STORAGE_UPLOAD_TRANSFER_URL/u);
    }
  });

  it('requires an encryption keyring before enabling object storage', () => {
    expect(() => loadConfig(appConfigSchema, { ...complete, ...objectStorage })).toThrow(
      /STORAGE_UPLOAD_RECEIPT_KEYS: required, not set/u,
    );
  });

  it('rejects an unknown active key and duplicate key IDs without disclosing values', () => {
    for (const invalid of [
      { ...receiptKeys, activeKeyId: 'missing' },
      { ...receiptKeys, keys: [receiptKeys.keys[0], receiptKeys.keys[0]] },
      { activeKeyId: 'current', keys: [{ id: 'current', key: 'invalid-private-value' }] },
    ]) {
      const environment = {
        ...complete,
        ...objectStorage,
        STORAGE_UPLOAD_RECEIPT_KEYS: JSON.stringify(invalid),
      };
      expect(() => loadConfig(appConfigSchema, environment)).toThrow(
        /STORAGE_UPLOAD_RECEIPT_KEYS/u,
      );
      expect(() => loadConfig(appConfigSchema, environment)).not.toThrow(/invalid-private-value/u);
    }
  });

  it('refuses partially configured storage without including credential values', () => {
    const environment = { ...complete, S3_ACCESS_KEY_ID: 'fixture-sensitive-value' };

    expect(() => loadConfig(appConfigSchema, environment)).toThrow(
      /S3_SECRET_ACCESS_KEY: required, not set/u,
    );
    expect(() => loadConfig(appConfigSchema, environment)).not.toThrow(/fixture-sensitive-value/u);
  });

  it('refuses an object storage URI with embedded credentials without including them', () => {
    const environment = {
      ...complete,
      ...configuredStorage,
      S3_PUBLIC_ENDPOINT: 'https://storage:fixture-sensitive-value@files.example.test',
    };

    expect(() => loadConfig(appConfigSchema, environment)).toThrow(/S3_PUBLIC_ENDPOINT:/u);
    expect(() => loadConfig(appConfigSchema, environment)).not.toThrow(/fixture-sensitive-value/u);
  });

  it('refuses to start without the database, the broker, the audience or the trusted issuers', () => {
    expect(() => loadConfig(appConfigSchema, { PORT: '3015' })).toThrow(ConfigError);
    try {
      loadConfig(appConfigSchema, { PORT: '3015' });
    } catch (error) {
      const issues: readonly string[] = (error as ConfigError).issues;
      expect(issues.map((issue) => issue.split(':')[0])).toEqual(
        expect.arrayContaining([
          'DATABASE_URL',
          'NATS_URL',
          'INTERNAL_TOKEN_AUDIENCE',
          'INTERNAL_TOKEN_TRUSTED_ISSUERS',
        ]),
      );
    }
  });

  it('refuses a database URL that is not PostgreSQL, without printing it', () => {
    const secret: string = 'mysql://storage_app:s3cret@localhost/storage';

    expect(() => loadConfig(appConfigSchema, { ...complete, DATABASE_URL: secret })).toThrow(
      /DATABASE_URL/u,
    );
    expect(() => loadConfig(appConfigSchema, { ...complete, DATABASE_URL: secret })).not.toThrow(
      /s3cret/u,
    );
  });

  it('refuses a broker URL that is not NATS, without printing it', () => {
    const secret: string = 'http://storage:s3cret@localhost:4222';

    expect(() => loadConfig(appConfigSchema, { ...complete, NATS_URL: secret })).toThrow(
      /NATS_URL/u,
    );
    expect(() => loadConfig(appConfigSchema, { ...complete, NATS_URL: secret })).not.toThrow(
      /s3cret/u,
    );
  });

  it('refuses a private key listed as a verification key', () => {
    const withPrivateKey: string = trustedIssuers.replace('"kid"', `"d":"${'A'.repeat(43)}","kid"`);

    expect(() =>
      loadConfig(appConfigSchema, { ...complete, INTERNAL_TOKEN_TRUSTED_ISSUERS: withPrivateKey }),
    ).toThrow(/INTERNAL_TOKEN_TRUSTED_ISSUERS/u);
  });

  it('does not read the migrator URL: the running service never needs it', () => {
    expect(loadConfig(appConfigSchema, complete)).not.toHaveProperty('MIGRATION_DATABASE_URL');
  });
});

describe('migrationConfigSchema', () => {
  it('reads the URL of the migrator role', () => {
    expect(
      loadConfig(migrationConfigSchema, {
        MIGRATION_DATABASE_URL:
          'postgres://storage_migrator:storage_migrator@localhost:5432/storage',
      }),
    ).toEqual({
      MIGRATION_DATABASE_URL: 'postgres://storage_migrator:storage_migrator@localhost:5432/storage',
    });
  });

  it('names MIGRATION_DATABASE_URL when it is missing', () => {
    expect(() =>
      loadConfig(migrationConfigSchema, {
        DATABASE_URL: 'postgres://storage_app:storage_app@localhost:5432/storage',
      }),
    ).toThrow(/MIGRATION_DATABASE_URL: required, not set/u);
  });

  it('names MIGRATION_DATABASE_URL when it is not a PostgreSQL URL, without printing it', () => {
    const secret: string = 'mysql://storage_migrator:s3cret@localhost/storage';

    expect(() => loadConfig(migrationConfigSchema, { MIGRATION_DATABASE_URL: secret })).toThrow(
      /MIGRATION_DATABASE_URL: Expected the postgres:\/\/ URL of the migrator role/u,
    );
    expect(() => loadConfig(migrationConfigSchema, { MIGRATION_DATABASE_URL: secret })).not.toThrow(
      /s3cret/u,
    );
  });
});
