import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  createApplication,
  InternalTokenSigner,
  loadConfig,
  runWithOrganizationContext,
} from '@cadenway/nest-common';
import type {
  Ed25519PrivateJwk,
  Ed25519PublicJwk,
  OrganizationContext,
} from '@cadenway/nest-common';
import { SystemTransactionRunner, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { appConfigSchema } from '../src/config/app-config.js';
import {
  PURGE_UPLOAD_RECEIPTS_QUEUE,
  RECONCILE_ATTACHMENT_OBJECTS_QUEUE,
  RECONCILE_PROFILE_MEDIA_QUEUE,
  SWEEP_ATTACHMENT_CLEANUP_QUEUE,
  SWEEP_PROFILE_MEDIA_QUEUE,
} from '../src/config/job-queues.js';
import {
  noStoreProfileMediaErrors,
  profileMediaPaths,
} from '../src/infrastructure/http/no-store-profile-media.middleware.js';
import { noStoreIntakeAttachmentParserErrors } from '../src/infrastructure/http/no-store-intake-attachments.middleware.js';
import type { AttachmentObjectStore } from '../src/modules/attachments/application/ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import { CleanPurgedTask } from '../src/modules/attachments/application/use-cases/commands/attachment/clean-purged-task/clean-purged-task.use-case.js';
import { CleanAttachmentObjects } from '../src/modules/attachments/application/use-cases/commands/attachment/clean-attachment-objects/clean-attachment-objects.use-case.js';
import { StartAttachmentUpload } from '../src/modules/attachments/application/use-cases/commands/attachment/start-attachment-upload/start-attachment-upload.use-case.js';
import { IntakeAttachment } from '../src/modules/attachments/domain/aggregates/intake-attachment/intake-attachment.aggregate.js';
import { UploadReceiptCodec } from '../src/modules/attachments/infrastructure/adapters/crypto/upload-receipt.codec.js';
import { PostgresAttachmentRuntime } from '../src/modules/attachments/infrastructure/adapters/runtime/postgres-attachment-runtime.adapter.js';
import { DrizzleAttachmentCleanupDiscovery } from '../src/modules/attachments/infrastructure/persistence/drizzle/repositories/attachment/drizzle-attachment-cleanup-discovery.repository.js';
import { DrizzleAttachmentReader } from '../src/modules/attachments/infrastructure/persistence/drizzle/repositories/attachment/drizzle-attachment-reader.repository.js';
import { DrizzleAttachmentReconciliation } from '../src/modules/attachments/infrastructure/persistence/drizzle/repositories/attachment/drizzle-attachment-reconciliation.repository.js';
import { DrizzleAttachmentTransaction } from '../src/modules/attachments/infrastructure/persistence/drizzle/repositories/attachment/drizzle-attachment-transaction.repository.js';
import { DrizzleExpiredUploadReceipts } from '../src/modules/attachments/infrastructure/persistence/drizzle/repositories/attachment/drizzle-expired-upload-receipts.repository.js';
import { DrizzleIntakeAttachmentTransaction } from '../src/modules/attachments/infrastructure/persistence/drizzle/repositories/attachment/drizzle-intake-attachment-transaction.repository.js';
import { DrizzleAttachmentCleanupUnitOfWork } from '../src/modules/attachments/infrastructure/persistence/drizzle/transactions/attachment/drizzle-attachment-cleanup.unit-of-work.js';
import { AbandonProfileMedia } from '../src/modules/profile-media/application/use-cases/commands/media/abandon-profile-media/abandon-profile-media.use-case.js';
import { ApplyProfileMediaChange } from '../src/modules/profile-media/application/use-cases/commands/media/apply-profile-media-change/apply-profile-media-change.use-case.js';
import {
  deleteExpiredProfileMediaReceipts,
  DrizzleProfileMediaCleanupTransaction,
} from '../src/modules/profile-media/infrastructure/persistence/drizzle/repositories/media/drizzle-profile-media-cleanup-transaction.repository.js';

// The service as main.ts assembles it, on a disposable PostgreSQL and NATS.
// `@cadenway/nest-testing` does not export its container fixtures yet and a service never depends
// on `testcontainers` itself, so the dependencies are those of compose.dev.yaml, started as a
// throwaway Compose project on free ports: PostgreSQL with the two roles of cadenway-ops, NATS with
// its authorization (the `storage` user, its subjects, the inbox prefix `_INBOX.storage`) and its
// three streams.

/** Compose file of the development dependencies. */
const composeFile: string = fileURLToPath(new URL('../compose.dev.yaml', import.meta.url));

/** Throwaway project name: it never touches the data of the developer's own dev stack. */
const project = `cadenway-storage-service-test-${String(process.pid)}`;

/**
 * Host port of NATS. Fixed for the run, unlike the ephemeral port of PostgreSQL: the service must
 * find NATS at the same address after the test restarts it, and Docker gives an ephemeral mapping a
 * new port at each start.
 */
let natsHostPort = '0';

/** Atelier Nord, the organization of the mockup. */
const atelierNordId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';

/** Another organization, which must never see a row of Atelier Nord. */
const otherOrganizationId = '01938f6e-0000-7000-8000-000000000002';

/** Camille Martin (CM), the member of Atelier Nord the mockup signs in as. */
const camilleMartinId = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24';

/** The tables of the platform module, as the kit names them. */
const platformTables = [
  'event_versions',
  'idempotency_keys',
  'outbox_events',
  'processed_events',
] as const;

/** Tables owned by the attachments module, in PostgreSQL name order. */
const attachmentTables = [
  'attachment_candidates',
  'attachment_reconciliation_cursors',
  'attachment_task_tombstones',
  'attachment_upload_claims',
  'attachments',
  'intake_attachment_candidates',
  'intake_attachment_upload_claims',
  'intake_attachments',
] as const;

const profileTables = [
  'profile_media_cursors',
  'profile_media_objects',
  'profile_media_owners',
  'profile_media_receipts',
  'profile_media_uploads',
] as const;

const serviceTables = [...attachmentTables, ...platformTables, ...profileTables].sort();

/**
 * Runs `docker compose` on the throwaway project.
 *
 * @param args - Compose command and its arguments.
 * @returns The standard output.
 */
function compose(...args: readonly string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--project-name', project, '--file', composeFile, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, DEV_POSTGRES_PORT: '0', DEV_NATS_PORT: natsHostPort },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/**
 * Runs the NATS command line of the `nats-streams` container against the broker of the project.
 *
 * @param env - Variables that replace the `admin` credentials of the container for this call.
 * @param args - Arguments of the `nats` command.
 * @returns Whether the broker accepted the command.
 */
function brokerAccepts(env: Readonly<Record<string, string>>, ...args: readonly string[]): boolean {
  const variables = Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]);
  try {
    compose('exec', '-T', ...variables, 'nats-streams', 'nats', '--timeout', '2s', ...args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a port of the loopback interface that nothing listens on.
 *
 * @returns A free port, released before it is returned.
 */
async function freePort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('The probe server has no TCP address.'));
        } else {
          resolve(String(address.port));
        }
      });
    });
  });
}

/**
 * Reads the published host port of a service of the project.
 *
 * @param service - Compose service.
 * @param port - Port inside the container.
 * @returns The host port.
 */
function hostPort(service: string, port: string): string {
  return compose('port', service, port).trim().split(':').at(-1) ?? '';
}

/**
 * Creates an Ed25519 key pair in the JWK forms the internal token uses.
 *
 * @returns The public key for the verifier and the private key for a signer.
 */
function keyPair(): {
  readonly publicJwk: Ed25519PublicJwk;
  readonly privateJwk: Ed25519PrivateJwk;
} {
  const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  if (x === undefined || d === undefined) {
    throw new Error('Node returned an Ed25519 JWK without its key material.');
  }
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x, kid: 'test-api-gateway' };
  return { publicJwk, privateJwk: { ...publicJwk, d } };
}

/**
 * The organization context of a member of an organization, as the internal token gives it.
 *
 * @param organizationId - Organization of the context.
 * @returns The context the tenant runner reads.
 */
function memberOf(organizationId: string): OrganizationContext {
  return {
    organizationId,
    actor: { type: 'user', id: camilleMartinId },
    role: null,
    scopes: [],
  };
}

/**
 * Applies the migrations with `src/migrate.ts`, the entry point of the migration container, as
 * the migrator role. Each call imports the module afresh, as each container start runs it once.
 */
async function runMigrator(): Promise<void> {
  vi.resetModules();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await import('../src/migrate.js');
  } finally {
    log.mockRestore();
  }
}

/** Releases the shutdown held by `ShutdownGate`. */
let releaseShutdown: () => void = () => undefined;

/** Settles once `releaseShutdown` is called. */
const shutdownReleased = new Promise<void>((resolve) => {
  releaseShutdown = resolve;
});

/**
 * Holds the shutdown after readiness turned down and before the listener closes, the way a slow
 * handler or relay pass would, so the probes can be read during the stop.
 */
@Injectable()
class ShutdownGate implements BeforeApplicationShutdown {
  public async beforeApplicationShutdown(): Promise<void> {
    await shutdownReleased;
  }
}

/** A route of the application that declares no exemption, like every business route will. */
@Controller('internal/v1/wiring-probe')
class WiringProbeController {
  @Get()
  public probe(): { readonly reached: true } {
    return { reached: true };
  }
}

describe('storage-service wiring', () => {
  const gateway = keyPair();
  let app: NestExpressApplication | undefined;
  let signer: InternalTokenSigner;
  let migrator: pg.Pool;

  /**
   * The running application.
   *
   * @returns The application created in `beforeAll`.
   */
  function service(): NestExpressApplication {
    if (app === undefined) {
      throw new Error('The application did not start.');
    }
    return app;
  }

  beforeAll(async () => {
    natsHostPort = await freePort();
    compose(
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '120',
      'postgres',
      'nats',
      'nats-streams',
    );
    const postgresPort = hostPort('postgres', '5432');

    vi.stubEnv(
      'MIGRATION_DATABASE_URL',
      `postgres://storage_migrator:storage_migrator@127.0.0.1:${postgresPort}/storage`,
    );
    await runMigrator();
    migrator = new pg.Pool({
      connectionString: `postgres://storage_migrator:storage_migrator@127.0.0.1:${postgresPort}/storage`,
      max: 1,
      // Kept open for the whole run, so the stop of PostgreSQL below always reaches it.
      idleTimeoutMillis: 0,
    });
    // The client is terminated (57P01) when a test stops PostgreSQL; the pool reports it as an
    // `error` event, which would otherwise be an uncaught exception.
    migrator.on('error', () => undefined);

    vi.stubEnv('PORT', '3015');
    vi.stubEnv('LOG_PRETTY', 'false');
    vi.stubEnv(
      'DATABASE_URL',
      `postgres://storage_app:storage_app@127.0.0.1:${postgresPort}/storage`,
    );
    vi.stubEnv('NATS_URL', `nats://127.0.0.1:${natsHostPort}`);
    vi.stubEnv('NATS_USER', 'storage');
    vi.stubEnv('NATS_PASSWORD', 'storage');
    vi.stubEnv('INTERNAL_TOKEN_AUDIENCE', 'storage-service');
    vi.stubEnv(
      'INTERNAL_TOKEN_TRUSTED_ISSUERS',
      JSON.stringify({ 'api-gateway': [gateway.publicJwk] }),
    );
    @Module({
      imports: [AppModule],
      controllers: [WiringProbeController],
      providers: [ShutdownGate],
    })
    class ProbedApplicationModule {}

    // As main.ts: the configuration is read inside the start-up, never when a module is imported.
    const config = loadConfig(appConfigSchema);
    app = await createApplication(ProbedApplicationModule, {
      service: 'storage-service',
      config,
      internalToken: {
        verifier: {
          audience: config.INTERNAL_TOKEN_AUDIENCE,
          trustedIssuers: config.INTERNAL_TOKEN_TRUSTED_ISSUERS,
        },
      },
      logDestination: { write: (): void => undefined },
    });
    app.use('/internal/v1/intake-publications', noStoreIntakeAttachmentParserErrors);
    app.use(profileMediaPaths, noStoreProfileMediaErrors);
    await app.init();
    signer = await InternalTokenSigner.create({
      issuer: 'api-gateway',
      privateJwk: gateway.privateJwk,
    });
  });

  afterAll(async () => {
    try {
      releaseShutdown();
      await app?.close();
      await migrator.end();
    } finally {
      vi.unstubAllEnvs();
      compose('down', '--volumes', '--remove-orphans');
    }
  });

  it('applies its migrations as the migrator role, which owns the service tables', async () => {
    const tables = await migrator.query<{ tablename: string; tableowner: string }>(
      `select tablename, tableowner from pg_tables where schemaname = 'public' order by tablename`,
    );
    const journal = await migrator.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );

    expect(tables.rows).toEqual(
      serviceTables.map((tablename) => ({
        tablename,
        tableowner: 'storage_migrator',
      })),
    );
    expect(journal.rows).toEqual([{ applied: 4 }]);
  });

  it('applies nothing when the migrator runs again', async () => {
    await runMigrator();

    const journal = await migrator.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );
    expect(journal.rows).toEqual([{ applied: 4 }]);
  });

  it('provisions all scheduled cleanup queues with the migrator', async () => {
    const expected = [
      PURGE_UPLOAD_RECEIPTS_QUEUE,
      RECONCILE_ATTACHMENT_OBJECTS_QUEUE,
      RECONCILE_PROFILE_MEDIA_QUEUE,
      SWEEP_ATTACHMENT_CLEANUP_QUEUE,
      SWEEP_PROFILE_MEDIA_QUEUE,
    ];
    const queues = await migrator.query<{ name: string }>(
      'select name from pgboss.queue where name = any($1::text[]) order by name',
      [expected],
    );

    expect(queues.rows.map((queue) => queue.name)).toEqual(expected);
  });

  it('forces row-level security on media tables and the platform outbox', async () => {
    const tables = await migrator.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class
        where relnamespace = 'public'::regnamespace and relkind = 'r'
        order by relname`,
    );
    const policies = await migrator.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies where schemaname = 'public' order by tablename`,
    );

    expect(tables.rows).toEqual(
      serviceTables.map((relname) => ({
        relname,
        relrowsecurity: relname !== 'processed_events',
        relforcerowsecurity: relname !== 'processed_events',
      })),
    );
    expect(policies.rows).toEqual(
      serviceTables
        .filter((table) => table !== 'processed_events')
        .map((tablename) => ({
          tablename,
          policyname:
            tablename === 'attachment_reconciliation_cursors'
              ? 'attachment_reconciliation_system_access'
              : tablename === 'profile_media_cursors'
                ? 'profile_media_cursors_system_access'
                : `${tablename}_organization_isolation`,
        })),
    );
  });

  it('keeps account media out of logo tenant transactions and isolates organization logo owners', async () => {
    const system: SystemTransactionRunner = service().get(SystemTransactionRunner);
    const tenant: TenantTransactionRunner = service().get(TenantTransactionRunner);
    const expectedLogo = { owner_kind: 'organization-logo', owner_id: atelierNordId };
    await system.run((scope) =>
      scope.client.query(
        `insert into profile_media_owners (organization_id, owner_kind, owner_id)
         values (null, 'avatar', $1), ($2, 'organization-logo', $2)`,
        [camilleMartinId, atelierNordId],
      ),
    );

    try {
      const read = (organizationId: string) =>
        runWithOrganizationContext(memberOf(organizationId), () =>
          tenant.run(async (scope) => {
            const result = await scope.client.query(
              `select owner_kind, owner_id from profile_media_owners
               where owner_id in ($1, $2) order by owner_kind`,
              [camilleMartinId, atelierNordId],
            );
            return result.rows;
          }),
        );
      await expect(read(atelierNordId)).resolves.toEqual([expectedLogo]);
      await expect(read(otherOrganizationId)).resolves.toEqual([]);
      await expect(
        runWithOrganizationContext(memberOf(otherOrganizationId), () =>
          tenant.run((scope) =>
            scope.client.query(
              `insert into profile_media_owners (organization_id, owner_kind, owner_id)
                values (null, 'avatar', $1)`,
              [otherOrganizationId],
            ),
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await system.run((scope) =>
        scope.client.query('delete from profile_media_owners where owner_id in ($1, $2)', [
          camilleMartinId,
          atelierNordId,
        ]),
      );
    }
  });

  it('preserves the largest published owner generation and retires explicitly stale assets', async () => {
    const owner = { kind: 'avatar', id: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b43' } as const;
    const retired = '019a7006-2c3d-7e4f-8a5b-6c7d8e9f0a33';
    const stale = '019a7006-2c3d-7e4f-8a5b-6c7d8e9f0a34';
    const explicitlyReplaced = '019a7006-2c3d-7e4f-8a5b-6c7d8e9f0a35';
    const change = service().get(ApplyProfileMediaChange);
    const system: SystemTransactionRunner = service().get(SystemTransactionRunner);
    await system.run(async (scope) => {
      await change.execute({
        owner,
        generation: Number.MAX_SAFE_INTEGER,
        assetId: null,
        oldAssetId: retired,
      });
      await change.execute({
        owner,
        generation: Number.MAX_SAFE_INTEGER - 1,
        assetId: stale,
        oldAssetId: explicitlyReplaced,
      });
      const ownerState = await scope.client.query(
        'select generation::text as generation, asset_id from profile_media_owners where owner_id = $1',
        [owner.id],
      );
      expect(ownerState.rows).toEqual([
        { generation: String(Number.MAX_SAFE_INTEGER), asset_id: null },
      ]);
      const uploads = await scope.client.query(
        'select upload_id, status from profile_media_uploads where owner_id = $1 order by upload_id',
        [owner.id],
      );
      expect(uploads.rows).toEqual(
        [retired, stale, explicitlyReplaced].map((upload_id) => ({ upload_id, status: 'retired' })),
      );
      await scope.client.query('delete from profile_media_uploads where owner_id = $1', [owner.id]);
      await scope.client.query('delete from profile_media_owners where owner_id = $1', [owner.id]);
    });
  });

  it('retires an abandoned reservation without shortening staging expiry or signed receipt replay', async () => {
    const owner = { kind: 'avatar', id: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b44' } as const;
    const uploadId = '019a7006-2c3d-7e4f-8a5b-6c7d8e9f0a36';
    const expiresAt = new Date(Date.now() + 3 * 60_000);
    const abandon = service().get(AbandonProfileMedia);
    const system: SystemTransactionRunner = service().get(SystemTransactionRunner);
    await system.run(async (scope) => {
      await scope.client.query(
        "insert into profile_media_owners (owner_kind, owner_id) values ('avatar', $1)",
        [owner.id],
      );
      await scope.client.query(
        `insert into profile_media_uploads
          (owner_kind, owner_id, upload_id, uploader_user_id, status, content_type, size_bytes, expires_at)
          values ('avatar', $1, $2, $1, 'pending', 'image/png', 12, $3)`,
        [owner.id, uploadId, expiresAt],
      );
      await scope.client.query(
        `insert into profile_media_objects
          (owner_kind, owner_id, upload_id, object_id, role, status, cleanup_after)
          values ('avatar', $1, $2, $2, 'staging', 'active', $3)`,
        [owner.id, uploadId, expiresAt],
      );
      await scope.client.query(
        `insert into profile_media_receipts
          (owner_kind, owner_id, upload_id, key_id, nonce, ciphertext, auth_tag, receipt_expires_at)
          values ('avatar', $1, $2, 'fixture', $3, $4, $5, $6)`,
        [owner.id, uploadId, Buffer.alloc(12), Buffer.from([1]), Buffer.alloc(16), expiresAt],
      );

      await abandon.execute({ owner, uploadId });
      const snapshot = await scope.client.query(
        `select u.status, o.status as object_status, o.cleanup_after, r.key_id
          from profile_media_uploads as u
          join profile_media_objects as o using (owner_kind, owner_id, upload_id)
          left join profile_media_receipts as r using (owner_kind, owner_id, upload_id)
          where u.owner_id = $1 and u.upload_id = $2`,
        [owner.id, uploadId],
      );
      expect(snapshot.rows).toEqual([
        { status: 'retired', object_status: 'fenced', cleanup_after: expiresAt, key_id: 'fixture' },
      ]);
      await deleteExpiredProfileMediaReceipts(scope, 20);
      const live = await scope.client.query(
        'select key_id from profile_media_receipts where owner_id = $1',
        [owner.id],
      );
      expect(live.rows).toEqual([{ key_id: 'fixture' }]);
      await scope.client.query(
        "update profile_media_receipts set receipt_expires_at = statement_timestamp() - interval '1 second' where owner_id = $1",
        [owner.id],
      );
      await deleteExpiredProfileMediaReceipts(scope, 20);
      const expired = await scope.client.query(
        'select key_id from profile_media_receipts where owner_id = $1',
        [owner.id],
      );
      expect(expired.rows).toEqual([]);

      const cleanup = new DrizzleProfileMediaCleanupTransaction(scope, owner);
      await scope.client.query(
        'update profile_media_owners set deleted = true, cleanup_requested = true where owner_id = $1',
        [owner.id],
      );
      expect(await cleanup.compactDeletedUploads(1)).toBe(0);
      await scope.client.query(
        "update profile_media_objects set status = 'cleaned' where owner_id = $1",
        [owner.id],
      );
      expect(await cleanup.compactDeletedUploads(1)).toBe(1);
      expect(await cleanup.finishDeletedOwner()).toBe(true);
      const fence = await scope.client.query(
        'select upload_id, status, uploader_user_id, content_type from profile_media_uploads where owner_id = $1',
        [owner.id],
      );
      expect(fence.rows).toEqual([
        { upload_id: uploadId, status: 'retired', uploader_user_id: null, content_type: null },
      ]);
      await scope.client.query('delete from profile_media_objects where owner_id = $1', [owner.id]);
      await scope.client.query('delete from profile_media_uploads where owner_id = $1', [owner.id]);
      await scope.client.query('delete from profile_media_owners where owner_id = $1', [owner.id]);
    });
  });
  it('isolates attachment metadata, candidates, purge records and upload claims by organization', async () => {
    const tenant = service().get(TenantTransactionRunner);
    const attachmentId = randomUUID();
    const objectKey = `org/${atelierNordId}/${attachmentId}`;
    const publicationId = '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f12';
    const statements: readonly { readonly sql: string; readonly values: readonly unknown[] }[] = [
      {
        sql: `insert into attachments
          (organization_id, id, task_key, author_user_id, object_key, staging_object_key, file_name,
           content_type, size_bytes, status, version, reserved_at, expires_at)
          values ($1, $2, 'CAD-482', $3, $4, $4 || '/staging', 'sprint-14.pdf',
                  'application/pdf', 128, 'pending', 1, now(), now() + interval '5 minutes')`,
        values: [atelierNordId, attachmentId, camilleMartinId, objectKey],
      },
      {
        sql: `insert into attachment_candidates
          (organization_id, attachment_id, object_key, cleanup_after)
          values ($1, $2, $3, now() + interval '5 minutes')`,
        values: [atelierNordId, attachmentId, `${objectKey}/candidate`],
      },
      {
        sql: `insert into attachment_task_tombstones (organization_id, task_key)
          values ($1, 'CAD-482')`,
        values: [atelierNordId],
      },
      {
        sql: `insert into attachment_upload_claims
          (organization_id, actor_id, task_key, key_digest, fingerprint, key_id, nonce,
           ciphertext, auth_tag, expires_at)
          values ($1, $2, 'CAD-482', 'test-digest', 'test-fingerprint', 'test-key',
                  $3, $4, $5, now() + interval '1 day')`,
        values: [
          atelierNordId,
          camilleMartinId,
          Buffer.alloc(12),
          Buffer.from([1, 2, 3]),
          Buffer.alloc(16),
        ],
      },
      {
        sql: `insert into intake_attachments (organization_id, publication_id, id, status, decided_at)
          values ($1, $2, $3, 'released', now())`,
        values: [atelierNordId, publicationId, attachmentId],
      },
      {
        sql: `insert into intake_attachment_candidates
          (organization_id, publication_id, attachment_id, object_key, status, cleanup_after)
          values ($1, $2, $3, $4, 'fenced', now() + interval '5 minutes')`,
        values: [atelierNordId, publicationId, attachmentId, `intake/${attachmentId}`],
      },
      {
        sql: `insert into intake_attachment_upload_claims
          (organization_id, publication_id, attachment_id, fingerprint, expires_at)
          values ($1, $2, $3, 'test-fingerprint', now() + interval '1 day')`,
        values: [atelierNordId, publicationId, attachmentId],
      },
    ];

    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (tx) => {
        for (const statement of statements) {
          await tx.client.query(statement.sql, [...statement.values]);
        }
      }),
    );

    for (const organizationId of [atelierNordId, otherOrganizationId]) {
      const counts = await runWithOrganizationContext(memberOf(organizationId), () =>
        tenant.run(async (tx) => {
          const result: number[] = [];
          for (const table of attachmentTables) {
            const count = await tx.client.query(`select count(*)::int as count from ${table}`);
            const rows = count.rows as readonly { readonly count: number }[];
            result.push(rows[0]?.count ?? -1);
          }
          return result;
        }),
      );
      expect(counts).toEqual(
        attachmentTables.map((table) =>
          organizationId === atelierNordId && table !== 'attachment_reconciliation_cursors' ? 1 : 0,
        ),
      );
    }

    for (const statement of statements) {
      await expect(
        runWithOrganizationContext(memberOf(otherOrganizationId), () =>
          tenant.run((tx) => tx.client.query(statement.sql, [...statement.values])),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }

    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (tx) => {
        for (const table of attachmentTables) {
          await tx.client.query(`delete from ${table}`);
        }
      }),
    );
  });

  it('shares the receipt cleanup batch limit with intake and preserves unexpired receipts', async () => {
    const system: SystemTransactionRunner = service().get(SystemTransactionRunner);
    const purge = new DrizzleExpiredUploadReceipts(system);
    const publicationId = '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f12';
    await system.run(async (tx) => {
      await tx.client.query(
        `insert into attachment_upload_claims
          (organization_id, actor_id, task_key, key_digest, fingerprint, expires_at)
          values ($1, $2, 'CAD-483', 'receipt-cleanup-test', 'test', now() - interval '1 hour')`,
        [atelierNordId, camilleMartinId],
      );
      await tx.client.query(
        `insert into intake_attachment_upload_claims
          (organization_id, publication_id, attachment_id, fingerprint, expires_at)
          values ($1, $3, uuidv7(), 'receipt-cleanup-test', now() - interval '1 hour'),
                 ($2, $3, uuidv7(), 'receipt-cleanup-test', now() - interval '2 hours'),
                 ($2, $3, uuidv7(), 'receipt-cleanup-test', now() + interval '1 hour')`,
        [atelierNordId, otherOrganizationId, publicationId],
      );

      await expect(purge.deleteBatch(2)).resolves.toBe(2);
      await expect(purge.deleteBatch(2)).resolves.toBe(1);
      await expect(purge.deleteBatch(2)).resolves.toBe(0);
      const remaining = await tx.client.query(
        `delete from intake_attachment_upload_claims
          where publication_id = $1 and fingerprint = 'receipt-cleanup-test'
          returning organization_id`,
        [publicationId],
      );
      expect(remaining.rows).toEqual([{ organization_id: otherOrganizationId }]);
    });
  });

  it('persists the exact signed cutoff with its encrypted intake receipt and replays it', async () => {
    const tenant: TenantTransactionRunner = service().get(TenantTransactionRunner);
    const identity = {
      organizationId: atelierNordId,
      publicationId: '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f13',
      attachmentId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f83',
    };
    const reservedAt = new Date();
    const stagingObjectKey = 'intake/019a7006-7a8b-7c9d-8e0f-1a2b3c4d5d82';
    const signedExpiry = new Date(reservedAt.getTime() + 4 * 60_000);
    const allocation = IntakeAttachment.reserve({
      ...identity,
      id: identity.attachmentId,
      stagingObjectKey,
      fileName: 'sprint-14.png',
      contentType: 'image/png',
      sizeBytes: 42,
      reservedAt,
      expiresAt: new Date(reservedAt.getTime() + 30 * 60_000),
    });
    const capability = {
      id: identity.attachmentId,
      method: 'POST',
      url: 'https://files.example.test/intake',
      fields: { key: stagingObjectKey },
      expiresAt: signedExpiry.toISOString(),
    } as const;
    const receipts = new UploadReceiptCodec({
      activeKeyId: 'intake-test',
      keys: [{ id: 'intake-test', key: randomBytes(32).toString('base64url') }],
    });

    await runWithOrganizationContext(
      {
        organizationId: atelierNordId,
        actor: { type: 'system', id: null },
        role: null,
        scopes: [],
      },
      () =>
        tenant.run(async (scope) => {
          const store = new DrizzleIntakeAttachmentTransaction(
            scope,
            atelierNordId,
            () => Promise.reject(new Error('Unexpected verification event.')),
            () => Promise.reject(new Error('Unexpected file event.')),
            receipts,
          );
          expect(await store.lock(identity)).toBeNull();
          const lease = await store.beginSigning(allocation);
          if (lease.kind !== 'acquired') throw new Error('Expected the original signing lease.');
          await expect(store.completeSigning(identity, lease.claimId, capability)).resolves.toEqual(
            { kind: 'completed' },
          );
          const stored = await store.lock(identity);
          expect(stored?.snapshot.reservation?.uploadExpiresAt).toEqual(signedExpiry);
          await expect(store.beginSigning(allocation)).resolves.toEqual({
            kind: 'replay',
            capability,
          });

          const keys = [identity.organizationId, identity.publicationId, identity.attachmentId];
          await scope.client.query(
            'delete from intake_attachment_upload_claims where organization_id = $1 and publication_id = $2 and attachment_id = $3',
            keys,
          );
          await scope.client.query(
            'delete from intake_attachment_candidates where organization_id = $1 and publication_id = $2 and attachment_id = $3',
            keys,
          );
          await scope.client.query(
            'delete from intake_attachments where organization_id = $1 and publication_id = $2 and id = $3',
            keys,
          );
        }),
    );
  });

  it('scrubs terminal intake declarations and receipts while retaining the object ledger and claimed file', async () => {
    const tenant: TenantTransactionRunner = service().get(TenantTransactionRunner);
    const receiptCodec = new UploadReceiptCodec({
      activeKeyId: 'intake-test',
      keys: [{ id: 'intake-test', key: randomBytes(32).toString('base64url') }],
    });
    const abort = new Error('rollback intake privacy fixture');
    const scopeContext = {
      organizationId: atelierNordId,
      actor: { type: 'system' as const, id: null },
      role: null,
      scopes: [],
    };
    await expect(
      runWithOrganizationContext(scopeContext, () =>
        tenant.run(async (scope) => {
          for (const [index, decision] of ['released', 'claimed'].entries()) {
            const identity = {
              organizationId: atelierNordId,
              publicationId: '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f13',
              attachmentId: `019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f9${String(index)}`,
            };
            const reservedAt = new Date();
            const staging = `intake/019a7006-7a8b-7c9d-8e0f-1a2b3c4d5e9${String(index)}`;
            const candidate = `org/${atelierNordId}/019a7006-7a8b-7c9d-8e0f-1a2b3c4d5d9${String(index)}`;
            const reserved = IntakeAttachment.reserve({
              ...identity,
              id: identity.attachmentId,
              stagingObjectKey: staging,
              fileName: 'applicant-private.png',
              contentType: 'image/png',
              sizeBytes: 42,
              reservedAt,
              expiresAt: new Date(reservedAt.getTime() + 1_800_000),
            });
            let files = 0;
            const store = () =>
              new DrizzleIntakeAttachmentTransaction(
                scope,
                atelierNordId,
                () => Promise.resolve(),
                () => {
                  files += 1;
                  return Promise.resolve();
                },
                receiptCodec,
              );
            const signing = store();
            await signing.lock(identity);
            expect((await signing.beginSigning(reserved)).kind).toBe('acquired');
            const verificationAt = new Date(reservedAt.getTime() + 1000);
            const verified = reserved.verify(
              candidate,
              { sizeBytes: 42, contentType: 'image/png', verifiedContentType: 'image/png' },
              verificationAt,
            );
            if (verified.event === null) throw new Error('Expected verified event.');
            await signing.registerCandidate(
              identity,
              candidate,
              reserved.snapshot.reservation?.expiresAt ?? reservedAt,
            );
            expect(
              await signing.electVerified(
                identity,
                verified.intakeAttachment,
                candidate,
                verified.event,
              ),
            ).toBe(true);
            const active = await signing.lock(identity);
            expect(active?.snapshot).toMatchObject({
              status: 'verified',
              candidateKey: candidate,
              reservation: { fileName: 'applicant-private.png' },
            });
            const terminal = store();
            if (decision === 'claimed') await terminal.lockTask(`CAD-${String(490 + index)}`);
            const current = await terminal.lock(identity);
            if (current === null) throw new Error('Expected reservation.');
            const change =
              decision === 'claimed'
                ? current.claim(`CAD-${String(490 + index)}`, false, verificationAt)
                : null;
            await terminal.saveDecision(
              identity,
              change?.intakeAttachment ?? current.release(verificationAt),
              change?.attachment ?? null,
              change?.event ?? null,
            );
            const keys = [identity.organizationId, identity.publicationId, identity.attachmentId];
            const stored = await scope.client.query(
              'select * from intake_attachments where organization_id=$1 and publication_id=$2 and id=$3',
              keys,
            );
            expect(stored.rows[0]).toMatchObject({
              status: decision,
              staging_object_key: null,
              file_name: null,
              content_type: null,
              size_bytes: null,
              reserved_at: null,
              expires_at: null,
              upload_expires_at: null,
              candidate_key: null,
              verified_at: null,
            });
            expect(
              (
                await scope.client.query(
                  'select * from intake_attachment_upload_claims where organization_id=$1 and publication_id=$2 and attachment_id=$3',
                  keys,
                )
              ).rows,
            ).toHaveLength(0);
            const ledger = await scope.client.query(
              'select object_key, status from intake_attachment_candidates where organization_id=$1 and publication_id=$2 and attachment_id=$3 order by object_key',
              keys,
            );
            expect(ledger.rows).toHaveLength(2);
            expect(ledger.rows).toContainEqual({
              object_key: candidate,
              status: decision === 'claimed' ? 'elected' : 'fenced',
            });
            const restored = await terminal.lock(identity);
            expect(restored?.snapshot).toMatchObject({
              status: decision,
              reservation: null,
              candidateKey: null,
              verifiedAt: null,
            });
            expect(
              restored?.claim(`CAD-${String(490 + index)}`, false, verificationAt).event,
            ).toBeNull();
            const attachment = await scope.client.query(
              'select file_name, elected_object_key from attachments where organization_id=$1 and id=$2',
              [atelierNordId, identity.attachmentId],
            );
            if (decision === 'claimed')
              expect(attachment.rows).toEqual([
                { file_name: 'applicant-private.png', elected_object_key: candidate },
              ]);
            else expect(attachment.rows).toHaveLength(0);
            expect(files).toBe(decision === 'claimed' ? 1 : 0);
          }
          throw abort;
        }),
      ),
    ).rejects.toBe(abort);
  });

  it('hides purged-task attachments from every reader before cleanup while retaining live tasks', async () => {
    const tenant: TenantTransactionRunner = service().get(TenantTransactionRunner);
    const reader = new DrizzleAttachmentReader(tenant);
    const liveKey = 'CAD-497';
    const purgedKey = 'CAD-498';
    const liveId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f71';
    const purgedId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f72';
    const asMember = <T>(work: () => Promise<T>): Promise<T> =>
      runWithOrganizationContext(memberOf(atelierNordId), work);

    try {
      await asMember(() =>
        tenant.run(async (scope) => {
          await scope.client.query(
            `insert into attachments
             (organization_id, id, task_key, author_user_id, object_key, staging_object_key,
              file_name, content_type, size_bytes, status, version, reserved_at, expires_at,
              uploaded_at, elected_object_key)
           select $1, id::uuid, task_key, $2, 'org/' || $1::uuid::text || '/' || id,
                  'org/' || $1::uuid::text || '/stage-' || id, 'sprint-14.pdf',
                  'application/pdf', bytes, 'ready', 1, '2026-11-20T08:00:00Z',
                  '2026-11-20T08:05:00Z', '2026-11-20T08:01:00Z',
                  'org/' || $1::uuid::text || '/winner-' || id
             from (values ($3::text, $4::text, 128), ($5::text, $6::text, 256))
                  as fixture(id, task_key, bytes)`,
            [atelierNordId, camilleMartinId, liveId, liveKey, purgedId, purgedKey],
          );
          await scope.client.query(
            `insert into attachment_task_tombstones (organization_id, task_key)
           values ($1, $2), ($1, $3)`,
            [atelierNordId, liveKey, purgedKey],
          );
        }),
      );
      await runWithOrganizationContext(memberOf(otherOrganizationId), () =>
        tenant.run((scope) =>
          scope.client.query(
            `insert into attachment_task_tombstones
             (organization_id, task_key, purged_at, purge_actor_type, purge_actor_id)
           values ($1, $2, now(), 'user', $3)`,
            [otherOrganizationId, liveKey, camilleMartinId],
          ),
        ),
      );

      await expect(
        asMember(() => reader.findReady(atelierNordId, purgedKey, purgedId)),
      ).resolves.toMatchObject({ attachment: { id: purgedId } });
      await asMember(() =>
        tenant.run((scope) =>
          scope.client.query(
            `update attachment_task_tombstones
           set purged_at = now(), purge_actor_type = 'user', purge_actor_id = $3,
               cleanup_pending = true
         where organization_id = $1 and task_key = $2`,
            [atelierNordId, purgedKey, camilleMartinId],
          ),
        ),
      );

      await expect(
        asMember(() => reader.findReady(atelierNordId, purgedKey, purgedId)),
      ).resolves.toBeNull();
      await expect(
        asMember(() => reader.findReady(atelierNordId, liveKey, liveId)),
      ).resolves.toMatchObject({ attachment: { id: liveId } });
      await expect(
        asMember(() =>
          reader.listTask({
            organizationId: atelierNordId,
            taskKey: purgedKey,
            cursor: null,
            limit: 10,
          }),
        ),
      ).resolves.toEqual({ items: [], nextCursor: null });
      await expect(
        asMember(() =>
          reader.listTask({
            organizationId: atelierNordId,
            taskKey: liveKey,
            cursor: null,
            limit: 10,
          }),
        ),
      ).resolves.toMatchObject({ items: [{ id: liveId }], nextCursor: null });
      await expect(
        asMember(() =>
          reader.listLargest({
            organizationId: atelierNordId,
            cursor: null,
            limit: 10,
          }),
        ),
      ).resolves.toMatchObject({ items: [{ id: liveId }], nextCursor: null });
    } finally {
      await asMember(() =>
        tenant.run(async (scope) => {
          await scope.client.query(
            'delete from attachments where organization_id = $1 and id in ($2, $3)',
            [atelierNordId, liveId, purgedId],
          );
          await scope.client.query(
            'delete from attachment_task_tombstones where organization_id = $1 and task_key in ($2, $3)',
            [atelierNordId, liveKey, purgedKey],
          );
        }),
      );
      await runWithOrganizationContext(memberOf(otherOrganizationId), () =>
        tenant.run((scope) =>
          scope.client.query(
            'delete from attachment_task_tombstones where organization_id = $1 and task_key = $2',
            [otherOrganizationId, liveKey],
          ),
        ),
      );
    }
  });

  it('purges attachments in bounded transactions and rolls back their outbox facts together', async () => {
    const tenant: TenantTransactionRunner = service().get(TenantTransactionRunner);
    const taskKey = 'CAD-491';
    const cutoff = new Date('2026-11-20T12:00:00.000Z');
    const runtime = { now: (): Date => cutoff, newId: (): Promise<string> => Promise.resolve('') };
    const actor = { type: 'user' as const, id: camilleMartinId };

    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (scope) => {
        await scope.client.query(
          `insert into attachment_task_tombstones
             (organization_id, task_key, purged_at, purge_actor_type, purge_actor_id, cleanup_pending)
           values ($1, $2, $3, 'user', $4, true)`,
          [atelierNordId, taskKey, cutoff, camilleMartinId],
        );
        await scope.client.query(
          `with fixture as (
             select ('019a7004-3b2c-7d4e-8f5a-' || lpad(to_hex(n), 12, '0'))::uuid as id,
                    uuidv7() as staging_id, n
             from generate_series(1, 502) as n
           )
           insert into attachments
             (organization_id, id, task_key, author_user_id, object_key, staging_object_key,
              file_name, content_type, size_bytes, status, version, reserved_at, expires_at,
              uploaded_at, elected_object_key)
           select $1::uuid, id, $2, $3, 'org/' || $1::uuid::text || '/' || id,
                  'org/' || $1::uuid::text || '/' || staging_id, 'sprint-14.pdf', 'application/pdf', 128,
                  case when n <= 2 then 'ready' else 'pending' end,
                  case when n <= 2 then 1 else 0 end,
                  '2026-11-08T08:00:00Z', '2026-11-08T08:05:00Z',
                  case when n <= 2 then '2026-11-08T08:01:00Z'::timestamptz else null end,
                  case when n <= 2 then 'org/' || $1::uuid::text || '/winner-' || id else null end
           from fixture`,
          [atelierNordId, taskKey, camilleMartinId],
        );
        await scope.client.query(
          `insert into attachment_candidates
             (organization_id, attachment_id, object_key, status, cleanup_after)
           select organization_id, id, elected_object_key, 'elected', $3
             from attachments where organization_id = $1 and task_key = $2 and status = 'ready'`,
          [atelierNordId, taskKey, cutoff],
        );
      }),
    );

    const discovery = new DrizzleAttachmentCleanupDiscovery(service().get(SystemTransactionRunner));
    const pending = { organizationId: atelierNordId, taskKey };
    await expect(discovery.listPurgedTasks(null)).resolves.toEqual([pending]);
    await expect(discovery.listPurgedTasks(pending)).resolves.toEqual([]);

    let failAfterFact = true;
    const work = new DrizzleAttachmentCleanupUnitOfWork(tenant, async (scope, fact, factActor) => {
      await scope.client.query(
        `insert into outbox_events (id, event_name, subject, stream, organization_id, payload, status)
         values ($1, $2, 'evt.file.deleted.v1', 'EVENTS', $3, $4, 'sent')`,
        [randomUUID(), fact.type, fact.organizationId, JSON.stringify({ fact, actor: factActor })],
      );
      if (failAfterFact) throw new Error('Abort the purge batch');
    });
    const purge = new CleanPurgedTask(work, runtime);
    const execute = (): ReturnType<CleanPurgedTask['execute']> =>
      runWithOrganizationContext(memberOf(atelierNordId), () =>
        purge.execute({ organizationId: atelierNordId, taskKey }),
      );

    await expect(execute()).rejects.toThrow('Abort the purge batch');
    const read = (): Promise<{ readonly deleted: number; readonly facts: number }> =>
      runWithOrganizationContext(memberOf(atelierNordId), () =>
        tenant.run(async (scope) => {
          const result = await scope.client.query(
            `select
               (select count(*)::int from attachments where organization_id = $1 and task_key = $2 and status = 'deleted') as deleted,
               (select count(*)::int from outbox_events where organization_id = $1 and payload->'fact'->>'taskKey' = $2) as facts`,
            [atelierNordId, taskKey],
          );
          const row = (result.rows as readonly { deleted: number; facts: number }[])[0];
          if (row === undefined) throw new Error('Missing purge counts');
          return row;
        }),
      );
    expect(await read()).toEqual({ deleted: 0, facts: 0 });
    failAfterFact = false;
    expect(await execute()).toEqual({ processed: 500, more: true });
    expect(await execute()).toEqual({ processed: 2, more: false });
    expect(await execute()).toEqual({ processed: 0, more: false });
    expect(await read()).toEqual({ deleted: 502, facts: 2 });
    await expect(discovery.listPurgedTasks(null)).resolves.toEqual([]);

    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (scope) => {
        const facts = await scope.client.query(
          `select payload->'actor' as actor from outbox_events
            where organization_id = $1 and payload->'fact'->>'taskKey' = $2`,
          [atelierNordId, taskKey],
        );
        expect((facts.rows as readonly { actor: unknown }[]).map((row) => row.actor)).toEqual([
          actor,
          actor,
        ]);
        await scope.client.query(
          'delete from attachment_candidates where organization_id = $1 and attachment_id in (select id from attachments where organization_id = $1 and task_key = $2)',
          [atelierNordId, taskKey],
        );
        await scope.client.query(
          'delete from attachments where organization_id = $1 and task_key = $2',
          [atelierNordId, taskKey],
        );
        await scope.client.query(
          'delete from attachment_task_tombstones where organization_id = $1 and task_key = $2',
          [atelierNordId, taskKey],
        );
        await scope.client.query(
          "delete from outbox_events where organization_id = $1 and payload->'fact'->>'taskKey' = $2",
          [atelierNordId, taskKey],
        );
      }),
    );
  });

  it('confirms object erasure across bounded pages and retries only current fences', async () => {
    const tenant: TenantTransactionRunner = service().get(TenantTransactionRunner);
    const taskKey = 'CAD-492';
    const cutoff = new Date('2026-11-20T12:00:00.000Z');
    const attachmentId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f21';
    const stagingId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f22';
    const electedKey = `org/${atelierNordId}/winner`;
    for (const organizationId of [atelierNordId, otherOrganizationId]) {
      await runWithOrganizationContext(memberOf(organizationId), () =>
        tenant.run(async (scope) => {
          await scope.client.query(
            `insert into attachments
               (organization_id, id, task_key, author_user_id, object_key, staging_object_key,
                file_name, content_type, size_bytes, status, version, reserved_at, expires_at,
                uploaded_at, elected_object_key)
             values ($1::uuid, $2::uuid, $3, $4, 'org/' || $1::uuid::text || '/' || $2::uuid::text,
                     'org/' || $1::uuid::text || '/' || $5::uuid::text, 'sprint-14.pdf', 'application/pdf', 128,
                     'ready', 1, '2026-11-08T08:00:00Z', '2026-11-08T08:05:00Z',
                     '2026-11-08T08:01:00Z', $6)`,
            [
              organizationId,
              attachmentId,
              taskKey,
              camilleMartinId,
              stagingId,
              `org/${organizationId}/winner`,
            ],
          );
          await scope.client.query(
            `insert into attachment_candidates
               (organization_id, attachment_id, object_key, status, cleanup_after)
             select $1::uuid, $2::uuid, 'org/' || $1::uuid::text || '/candidate-' || lpad(n::text, 4, '0'), 'active', $3
               from generate_series(1, 501) as n`,
            [organizationId, attachmentId, cutoff],
          );
          if (organizationId === atelierNordId) {
            await scope.client.query(
              `insert into attachment_candidates
                 (organization_id, attachment_id, object_key, status, cleanup_after)
               values ($1, $2, $3, 'elected', $4)`,
              [organizationId, attachmentId, electedKey, cutoff],
            );
          }
        }),
      );
    }

    const discovery = new DrizzleAttachmentCleanupDiscovery(service().get(SystemTransactionRunner));
    await expect(
      discovery.listDueObjectOrganizations(new Date(cutoff.getTime() - 1), null),
    ).resolves.toEqual([]);
    await expect(discovery.listDueObjectOrganizations(cutoff, null)).resolves.toEqual([
      otherOrganizationId,
      atelierNordId,
    ]);
    await expect(
      discovery.listDueObjectOrganizations(cutoff, otherOrganizationId),
    ).resolves.toEqual([atelierNordId]);
    await expect(discovery.listDueObjectOrganizations(cutoff, atelierNordId)).resolves.toEqual([]);

    const removed: string[] = [];
    const failedKey = `org/${atelierNordId}/candidate-0001`;
    const generations = new Map<string, number>();
    const work = new DrizzleAttachmentCleanupUnitOfWork(tenant, () => Promise.resolve());
    const clean = new CleanAttachmentObjects(work, {
      deleteObject: async (objectKey: string): Promise<void> => {
        const candidate = await runWithOrganizationContext(memberOf(atelierNordId), () =>
          tenant.run(async (scope) => {
            const result = await scope.db.execute<{
              status: string;
              cleanup_generation: number;
            }>(sql`
              select status, cleanup_generation from attachment_candidates
              where organization_id = ${atelierNordId} and object_key = ${objectKey}
            `);
            return result.rows[0];
          }),
        );
        if (candidate === undefined) throw new Error('Missing erasure fence.');
        expect(candidate.status).toBe('fenced');
        const firstAttempt = !generations.has(objectKey);
        generations.set(objectKey, candidate.cleanup_generation);
        if (objectKey === failedKey && firstAttempt) throw new Error('Temporary storage failure.');
        removed.push(objectKey);
      },
    });
    const run = (
      after: { readonly cleanupAfter: Date; readonly objectKey: string } | null,
      dueAt = cutoff,
    ): ReturnType<CleanAttachmentObjects['execute']> =>
      runWithOrganizationContext(memberOf(atelierNordId), () =>
        clean.execute({
          organizationId: atelierNordId,
          cutoff: dueAt,
          after,
          signal: AbortSignal.timeout(30_000),
        }),
      );
    const first = await run(null);
    expect(first.processed).toBe(49);
    expect(first.failed).toBe(1);
    expect(first.next).not.toBeNull();
    let next = first.next;
    for (let page = 0; next !== null && page < 10; page += 1) {
      const result = await run(next);
      expect(result.failed).toBe(0);
      next = result.next;
    }
    expect(next).toBeNull();
    expect(removed).toHaveLength(500);
    expect(removed).not.toContain(electedKey);
    expect(removed.every((key) => key.startsWith(`org/${atelierNordId}/`))).toBe(true);
    expect(await run(null)).toEqual({ processed: 0, failed: 0, next: null });

    const retryEpochMilliseconds = await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (scope) => {
        const statuses = await scope.db.execute<{ status: string; count: number }>(sql`
          select status, count(*)::int from attachment_candidates
          where organization_id = ${atelierNordId} and attachment_id = ${attachmentId}
          group by status order by status
        `);
        expect(statuses.rows).toEqual([
          { status: 'cleaned', count: 500 },
          { status: 'elected', count: 1 },
          { status: 'fenced', count: 1 },
        ]);
        const rows = await scope.db.execute<{ retryEpochMilliseconds: number }>(sql`
          select (extract(epoch from cleanup_after) * 1000)::double precision as "retryEpochMilliseconds"
          from attachment_candidates
          where organization_id = ${atelierNordId} and object_key = ${failedKey}
        `);
        return rows.rows[0]?.retryEpochMilliseconds;
      }),
    );
    if (retryEpochMilliseconds === undefined) throw new Error('Missing erasure retry.');
    const retryAt = new Date(retryEpochMilliseconds);
    expect(retryAt.getTime()).toBeGreaterThan(cutoff.getTime());
    expect(await run(null, retryAt)).toEqual({ processed: 1, failed: 0, next: null });
    expect(removed.at(-1)).toBe(failedKey);
    await expect(discovery.listDueObjectOrganizations(retryAt, null)).resolves.toEqual([
      otherOrganizationId,
    ]);

    // A reconciliation page requeues a key it observed after the first erasure completed.
    const reactivatedKey = removed[0];
    const staleGeneration =
      reactivatedKey === undefined ? undefined : generations.get(reactivatedKey);
    if (reactivatedKey === undefined || staleGeneration === undefined)
      throw new Error('Missing an earlier erasure.');
    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (scope) => {
        await scope.client.query(
          `update attachment_candidates set status = 'fenced', cleanup_after = $3,
             cleanup_generation = cleanup_generation + 1
           where organization_id = $1 and object_key = $2 and status = 'cleaned'`,
          [atelierNordId, reactivatedKey, retryAt],
        );
      }),
    );
    await expect(
      runWithOrganizationContext(memberOf(atelierNordId), () =>
        work.run(atelierNordId, (store) =>
          store.settleObjectErasures([
            { objectKey: reactivatedKey, generation: staleGeneration, erased: true },
          ]),
        ),
      ),
    ).resolves.toBe(0);
    expect(await run(null, retryAt)).toEqual({ processed: 1, failed: 0, next: null });
    expect(removed.at(-1)).toBe(reactivatedKey);
    await runWithOrganizationContext(memberOf(otherOrganizationId), () =>
      tenant.run(async (scope) => {
        const result = await scope.client.query(
          `select count(*)::int as count from attachment_candidates
           where organization_id = $1 and status = 'active'`,
          [otherOrganizationId],
        );
        expect(result.rows).toEqual([{ count: 501 }]);
      }),
    );

    for (const organizationId of [atelierNordId, otherOrganizationId]) {
      await runWithOrganizationContext(memberOf(organizationId), () =>
        tenant.run(async (scope) => {
          await scope.client.query(
            'delete from attachment_candidates where organization_id = $1 and attachment_id = $2',
            [organizationId, attachmentId],
          );
          await scope.client.query(
            'delete from attachments where organization_id = $1 and id = $2',
            [organizationId, attachmentId],
          );
          await scope.client.query(
            'delete from attachment_task_tombstones where organization_id = $1 and task_key = $2',
            [organizationId, taskKey],
          );
        }),
      );
    }
  });

  it('discards an expired staged reservation before erasing its object', async () => {
    const tenant: TenantTransactionRunner = service().get(TenantTransactionRunner);
    const taskKey = 'CAD-494';
    const cutoff = new Date('2026-11-20T12:00:00.000Z');
    const ids = [
      {
        attachmentId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f41',
        stagingId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f42',
        expiresAt: cutoff,
      },
      {
        attachmentId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f43',
        stagingId: '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f44',
        expiresAt: new Date(cutoff.getTime() + 1),
      },
    ];
    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (scope) => {
        for (const { attachmentId, stagingId, expiresAt } of ids) {
          const stagingKey = `org/${atelierNordId}/${stagingId}`;
          await scope.client.query(
            `insert into attachments
               (organization_id, id, task_key, author_user_id, object_key, staging_object_key,
                file_name, content_type, size_bytes, status, version, reserved_at, expires_at)
             values ($1, $2, $3, $4, $5, $6, 'sprint-14.pdf', 'application/pdf', 128,
                     'pending', 0, '2026-11-20T11:55:00.000Z', $7)`,
            [
              atelierNordId,
              attachmentId,
              taskKey,
              camilleMartinId,
              `org/${atelierNordId}/${attachmentId}`,
              stagingKey,
              expiresAt,
            ],
          );
          await scope.client.query(
            `insert into attachment_candidates
               (organization_id, attachment_id, object_key, status, cleanup_after)
             values ($1, $2, $3, 'staging', $4)`,
            [atelierNordId, attachmentId, stagingKey, expiresAt],
          );
        }
      }),
    );

    const writeFact = vi.fn(() => Promise.resolve());
    const deleteObject = vi.fn(async (key: string) => {
      const snapshots = await tenant.run(async ({ db }) =>
        db.execute<{ status: string; version: number; atCutoff: boolean }>(sql`
          select status, version, deleted_at = ${cutoff.toISOString()}::timestamptz as "atCutoff"
          from attachments where organization_id = ${atelierNordId} and task_key = ${taskKey}
          order by id
        `),
      );
      expect(snapshots.rows).toEqual([
        { status: 'deleted', version: 1, atCutoff: true },
        { status: 'pending', version: 0, atCutoff: null },
      ]);
      expect(key).toBe(`org/${atelierNordId}/019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f42`);
    });
    const cleaner = new CleanAttachmentObjects(
      new DrizzleAttachmentCleanupUnitOfWork(tenant, writeFact),
      { deleteObject },
    );
    await expect(
      runWithOrganizationContext(memberOf(atelierNordId), () =>
        cleaner.execute({
          organizationId: atelierNordId,
          cutoff,
          after: null,
          signal: AbortSignal.timeout(10_000),
        }),
      ),
    ).resolves.toEqual({ processed: 1, failed: 0, next: null });
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(writeFact).not.toHaveBeenCalled();

    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (scope) => {
        await scope.client.query(
          `delete from attachment_candidates where organization_id = $1
             and attachment_id in (select id from attachments where organization_id = $1 and task_key = $2)`,
          [atelierNordId, taskKey],
        );
        await scope.client.query(
          'delete from attachments where organization_id = $1 and task_key = $2',
          [atelierNordId, taskKey],
        );
        await scope.client.query(
          'delete from attachment_task_tombstones where organization_id = $1 and task_key = $2',
          [atelierNordId, taskKey],
        );
      }),
    );
  });

  it('keeps a candidate elected while cleanup waits on the task lock', async () => {
    const tenant: TenantTransactionRunner = service().get(TenantTransactionRunner);
    const attachmentId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f31';
    const stagingId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f32';
    const objectKey = `org/${atelierNordId}/${attachmentId}`;
    const candidateKey = `org/${atelierNordId}/candidate-race`;
    const cutoff = new Date('2026-11-20T12:00:00.000Z');
    const taskKey = 'CAD-493';
    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (scope) => {
        await scope.client.query(
          `insert into attachment_task_tombstones (organization_id, task_key) values ($1, $2)`,
          [atelierNordId, taskKey],
        );
        await scope.client.query(
          `insert into attachments
             (organization_id, id, task_key, author_user_id, object_key, staging_object_key,
              file_name, content_type, size_bytes, status, version, reserved_at, expires_at)
           values ($1, $2, $3, $4, $5, $6, 'sprint-14.pdf', 'application/pdf', 128,
                   'pending', 0, '2026-11-08T08:00:00Z', '2026-11-08T08:05:00Z')`,
          [
            atelierNordId,
            attachmentId,
            taskKey,
            camilleMartinId,
            objectKey,
            `org/${atelierNordId}/${stagingId}`,
          ],
        );
        await scope.client.query(
          `insert into attachment_candidates
             (organization_id, attachment_id, object_key, status, cleanup_after)
           values ($1, $2, $3, 'active', $4)`,
          [atelierNordId, attachmentId, candidateKey, cutoff],
        );
      }),
    );

    let unlock: () => void = () => undefined;
    let locked: () => void = () => undefined;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const election = runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (scope) => {
        await scope.client.query(
          'select task_key from attachment_task_tombstones where organization_id = $1 and task_key = $2 for update',
          [atelierNordId, taskKey],
        );
        await scope.client.query(
          `update attachments set status = 'ready', version = 1,
             uploaded_at = '2026-11-08T08:01:00Z', elected_object_key = $3
           where organization_id = $1 and id = $2`,
          [atelierNordId, attachmentId, candidateKey],
        );
        await scope.client.query(
          `update attachment_candidates set status = 'elected'
           where organization_id = $1 and object_key = $2`,
          [atelierNordId, candidateKey],
        );
        locked();
        await released;
      }),
    );
    await lockHeld;
    const removed: string[] = [];
    const cleaner = new CleanAttachmentObjects(
      new DrizzleAttachmentCleanupUnitOfWork(tenant, () => Promise.resolve()),
      {
        deleteObject: (key: string): Promise<void> => {
          removed.push(key);
          return Promise.resolve();
        },
      },
    );
    const cleanup = runWithOrganizationContext(memberOf(atelierNordId), () =>
      cleaner.execute({
        organizationId: atelierNordId,
        cutoff,
        after: null,
        signal: AbortSignal.timeout(10_000),
      }),
    );
    void cleanup.catch(() => undefined);
    try {
      await vi.waitFor(
        async () => {
          const waiting = await migrator.query<{ count: number }>(
            'select count(*)::int as count from pg_locks where not granted',
          );
          expect(waiting.rows[0]?.count).toBeGreaterThan(0);
        },
        { timeout: 1_000, interval: 10 },
      );
    } finally {
      unlock();
    }
    await election;
    expect(await cleanup).toEqual({ processed: 0, failed: 0, next: null });
    expect(removed).toEqual([]);
    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (scope) => {
        const rows = await scope.client.query(
          'select status from attachment_candidates where organization_id = $1 and object_key = $2',
          [atelierNordId, candidateKey],
        );
        expect(rows.rows).toEqual([{ status: 'elected' }]);
        await scope.client.query(
          'delete from attachment_candidates where organization_id = $1 and attachment_id = $2',
          [atelierNordId, attachmentId],
        );
        await scope.client.query('delete from attachments where organization_id = $1 and id = $2', [
          atelierNordId,
          attachmentId,
        ]);
        await scope.client.query(
          'delete from attachment_task_tombstones where organization_id = $1 and task_key = $2',
          [atelierNordId, taskKey],
        );
      }),
    );
  });

  it('locks only the elected object of a ready attachment in the verified tenant', async () => {
    const tenant: TenantTransactionRunner = service().get(TenantTransactionRunner);
    const attachmentId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
    const stagingId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f16';
    const objectKey = `org/${atelierNordId}/${attachmentId}`;
    const stagingKey = `org/${atelierNordId}/${stagingId}`;
    const electedKey = `org/${atelierNordId}/elected-fixture`;
    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (scope) => {
        await scope.client.query(
          `insert into attachments
            (organization_id, id, task_key, author_user_id, object_key, staging_object_key,
             file_name, content_type, size_bytes, status, version, reserved_at, expires_at,
             uploaded_at, elected_object_key)
           values ($1, $2, 'CAD-483', $3, $4, $5, 'sprint-14.pdf', 'application/pdf', 128,
                   'ready', 1, '2026-11-08T08:00:00Z', '2026-11-08T08:05:00Z',
                   '2026-11-08T08:01:00Z', $6)`,
          [atelierNordId, attachmentId, camilleMartinId, objectKey, stagingKey, electedKey],
        );
        const store = new DrizzleAttachmentTransaction(
          scope,
          atelierNordId,
          () => Promise.resolve(),
          undefined,
        );
        expect(await store.lockTask('CAD-483')).toBe(false);
        expect(
          (await store.lockAttachment('CAD-483', attachmentId, electedKey))?.snapshot.status,
        ).toBe('ready');
        expect(
          await store.lockAttachment('CAD-483', attachmentId, `${electedKey}-other`),
        ).toBeNull();
        expect(await store.lockAttachment('CAD-484', attachmentId, electedKey)).toBeNull();
      }),
    );
    await runWithOrganizationContext(memberOf(otherOrganizationId), () =>
      tenant.run(async (scope) => {
        const store = new DrizzleAttachmentTransaction(
          scope,
          otherOrganizationId,
          () => Promise.resolve(),
          undefined,
        );
        expect(await store.lockAttachment('CAD-483', attachmentId, electedKey)).toBeNull();
      }),
    );
    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (scope) => {
        await scope.client.query('delete from attachments where organization_id = $1 and id = $2', [
          atelierNordId,
          attachmentId,
        ]);
        await scope.client.query(
          'delete from attachment_task_tombstones where organization_id = $1 and task_key = $2',
          [atelierNordId, 'CAD-483'],
        );
      }),
    );
  });

  it('fences a late signer after lease takeover and replays only the encrypted winner', async () => {
    const tenant: TenantTransactionRunner = service().get(TenantTransactionRunner);
    const taskKey = 'CAD-723';
    const key = 'upload-claim-takeover-fixture';
    const keyDigest = createHash('sha256').update(key).digest('hex');
    const matchingClaim = sql`organization_id = ${atelierNordId} and actor_id = ${camilleMartinId}
      and task_key = ${taskKey} and key_digest = ${keyDigest}`;
    const issuer = new EventEmitter();
    const started = once(issuer, 'started');
    const continueSigning = once(issuer, 'continue');
    const signUpload = vi.fn<AttachmentObjectStore['signUpload']>();
    signUpload.mockImplementation(async ({ attachmentId, expiresAt }) => {
      if (signUpload.mock.calls.length === 1) {
        issuer.emit('started');
        await continueSigning;
      }
      return {
        id: attachmentId,
        method: 'POST',
        url: 'https://files.example.test/claim-takeover',
        fields: { policy: `signed-fixture-${attachmentId}` },
        expiresAt: new Date(expiresAt.getTime() - 1000).toISOString(),
      };
    });
    const receipts = new UploadReceiptCodec({
      activeKeyId: 'claim-test',
      keys: [{ id: 'claim-test', key: randomBytes(32).toString('base64url') }],
    });
    const upload = new StartAttachmentUpload(
      {
        run: (organizationId, work) =>
          tenant.run((scope) =>
            work(
              new DrizzleAttachmentTransaction(
                scope,
                organizationId,
                () => Promise.resolve(),
                receipts,
              ),
            ),
          ),
      },
      { signUpload, copyAndVerify: vi.fn(), signDownload: vi.fn() },
      new PostgresAttachmentRuntime(tenant),
      { lookup: () => 'image/png' },
    );
    const startUpload = (fingerprint: string) =>
      runWithOrganizationContext(memberOf(atelierNordId), () =>
        upload.execute({
          organizationId: atelierNordId,
          actorId: camilleMartinId,
          taskKey,
          fileName: 'sprint-14.png',
          contentType: 'image/png',
          sizeBytes: 128,
          idempotencyKey: key,
          fingerprint,
        }),
      );
    const fingerprint = 'a'.repeat(64);
    const initial = startUpload(fingerprint);

    try {
      await Promise.race([
        started,
        initial.then(() => {
          throw new Error('Reservation completed before its signer was released.');
        }),
      ]);
      await expect(startUpload(fingerprint)).rejects.toMatchObject({
        reason: 'request-in-progress',
      });
      await expect(startUpload('b'.repeat(64))).rejects.toMatchObject({
        reason: 'idempotency-key-reused',
      });
      expect(signUpload).toHaveBeenCalledTimes(1);

      const expired = await runWithOrganizationContext(memberOf(atelierNordId), () =>
        tenant.run(({ db }) =>
          db.execute<{ claim_id: string; key_id: string | null }>(sql`
            update attachment_upload_claims
               set expires_at = statement_timestamp() - interval '1 second'
             where ${matchingClaim}
            returning claim_id, key_id
          `),
        ),
      );
      expect(expired.rows).toHaveLength(1);
      expect(expired.rows[0]?.key_id).toBeNull();
      expect(typeof expired.rows[0]?.claim_id).toBe('string');

      const winner = await startUpload(fingerprint);
      expect(winner.replayed).toBe(false);
      issuer.emit('continue');
      await expect(initial).resolves.toEqual({ capability: winner.capability, replayed: true });
      await expect(startUpload(fingerprint)).resolves.toEqual({
        capability: winner.capability,
        replayed: true,
      });
      expect(signUpload).toHaveBeenCalledTimes(2);

      await runWithOrganizationContext(memberOf(atelierNordId), () =>
        tenant.run(async ({ db }) => {
          const receipt = await db.execute<{
            claim_id: string;
            key_id: string;
            nonce_size: number;
            tag_size: number;
            ciphertext: Buffer;
            expires_within_day: boolean;
          }>(sql`
             select claim_id, key_id, octet_length(nonce) as nonce_size,
                    octet_length(auth_tag) as tag_size, ciphertext,
                    expires_at between statement_timestamp() + interval '23 hours'
                                   and statement_timestamp() + interval '24 hours' as expires_within_day
               from attachment_upload_claims
              where ${matchingClaim}
          `);
          expect(receipt.rows).toHaveLength(1);
          const [winnerReceipt] = receipt.rows;
          expect(winnerReceipt).toMatchObject({
            key_id: 'claim-test',
            nonce_size: 12,
            tag_size: 16,
            expires_within_day: true,
          });
          expect(winnerReceipt?.claim_id).not.toBe(expired.rows[0]?.claim_id);
          expect(winnerReceipt?.ciphertext.includes(winner.capability.url)).toBe(false);
          const signedExpiry = winner.capability.expiresAt;
          const reserved = await db.execute<{
            id: string;
            exact_expiry: boolean;
            exact_cleanup: boolean;
          }>(sql`
             select a.id, a.expires_at = ${signedExpiry}::timestamptz as exact_expiry,
                    candidate.cleanup_after = ${signedExpiry}::timestamptz as exact_cleanup
               from attachments a
               join attachment_candidates candidate
                 on candidate.organization_id = a.organization_id and candidate.attachment_id = a.id
              where a.organization_id = ${atelierNordId} and a.task_key = ${taskKey}
          `);
          expect(reserved.rows).toEqual([
            { id: winner.capability.id, exact_expiry: true, exact_cleanup: true },
          ]);
        }),
      );
    } finally {
      issuer.emit('continue');
      await initial.catch(() => undefined);
    }
  });

  it('stores upload replay claims as encrypted fields with bounded nonce and tag lengths', async () => {
    const columns = await migrator.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type
         from information_schema.columns
        where table_schema = 'public' and table_name = 'attachment_upload_claims'
        order by ordinal_position`,
    );
    expect(columns.rows).toEqual([
      { column_name: 'organization_id', data_type: 'uuid' },
      { column_name: 'actor_id', data_type: 'uuid' },
      { column_name: 'task_key', data_type: 'text' },
      { column_name: 'key_digest', data_type: 'text' },
      { column_name: 'fingerprint', data_type: 'text' },
      { column_name: 'claim_id', data_type: 'uuid' },
      { column_name: 'key_id', data_type: 'text' },
      { column_name: 'nonce', data_type: 'bytea' },
      { column_name: 'ciphertext', data_type: 'bytea' },
      { column_name: 'auth_tag', data_type: 'bytea' },
      { column_name: 'expires_at', data_type: 'timestamp with time zone' },
    ]);
    const indexes = await migrator.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'attachment_upload_claims'
        order by indexname`,
    );
    expect(
      indexes.rows.find(({ indexname }) => indexname === 'attachment_upload_claims_expiry_index')
        ?.indexdef,
    ).toContain('(expires_at, organization_id, actor_id, task_key, key_digest)');

    const tenant = service().get(TenantTransactionRunner);
    for (const [nonceLength, tagLength] of [
      [11, 16],
      [12, 15],
    ] as const) {
      await expect(
        runWithOrganizationContext(memberOf(atelierNordId), () =>
          tenant.run((tx) =>
            tx.client.query(
              `insert into attachment_upload_claims
                (organization_id, actor_id, task_key, key_digest, fingerprint, key_id, nonce,
                 ciphertext, auth_tag, expires_at)
               values ($1, $2, 'CAD-482', 'test-digest', 'test-fingerprint', 'test-key',
                       $3, $4, $5, now() + interval '1 day')`,
              [
                atelierNordId,
                camilleMartinId,
                Buffer.alloc(nonceLength),
                Buffer.from([1, 2, 3]),
                Buffer.alloc(tagLength),
              ],
            ),
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('answers the liveness probe without a token', async () => {
    const response = await request(service().getHttpServer()).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok' });
  });

  it('is ready once PostgreSQL answers the application role and NATS the storage user', async () => {
    const response = await request(service().getHttpServer()).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      details: { postgres: { status: 'up' }, nats: { status: 'up' } },
    });
  });

  it('refuses a route of the application without an internal token', async () => {
    const response = await request(service().getHttpServer()).get('/internal/v1/wiring-probe');

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/u);
    expect(response.body).toMatchObject({ status: 401, code: 'auth.token-missing' });
  });

  it('serves a route to a trusted issuer acting for a member of the organization', async () => {
    const token = await signer.sign('storage-service', {
      actor: { type: 'user', id: camilleMartinId },
      organizationId: atelierNordId,
    });

    const response = await request(service().getHttpServer())
      .get('/internal/v1/wiring-probe')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ reached: true });
  });

  it('mounts an authenticated account avatar path and hides absent derivatives without caching', async () => {
    const token = await signer.sign('storage-service', {
      actor: { type: 'user', id: camilleMartinId },
      organizationId: null,
    });
    const assetId = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b99';
    const response = await request(service().getHttpServer())
      .get(`/internal/v1/avatars/${assetId}`)
      .query({ ownerUserId: camilleMartinId })
      .set('Authorization', `Bearer ${token}`)
      .set('If-None-Match', '*');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'media.not-found' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses a token signed for another service', async () => {
    const token = await signer.sign('document-service', {
      actor: { type: 'user', id: camilleMartinId },
      organizationId: atelierNordId,
    });

    const response = await request(service().getHttpServer())
      .get('/internal/v1/wiring-probe')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: 'auth.token-invalid',
      details: { reason: 'audience' },
    });
  });

  it('lets the application role read and write the platform tables of its organization only', async () => {
    const tenant = service().get(TenantTransactionRunner);
    const countAll = async (organizationId: string): Promise<Record<string, number>> =>
      runWithOrganizationContext(memberOf(organizationId), () =>
        tenant.run(async (tx) => {
          const counts = await tx.client.query(
            `select 'outbox_events' as name, count(*)::int as rows from outbox_events
             union all select 'event_versions', count(*)::int from event_versions
             union all select 'idempotency_keys', count(*)::int from idempotency_keys`,
          );
          const rows = counts.rows as readonly { readonly name: string; readonly rows: number }[];
          return Object.fromEntries(rows.map(({ name, rows: count }) => [name, count]));
        }),
      );

    // Sent rather than pending: the relay must have nothing to publish.
    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (tx) => {
        await tx.client.query(
          `insert into outbox_events
             (id, event_name, subject, stream, organization_id, payload, status, sent_at)
           values (uuidv7(), 'file.wiring-probe.v1', 'evt.file.wiring-probe.v1', 'EVENTS', $1,
                   '{}', 'sent', now())`,
          [atelierNordId],
        );
        await tx.client.query(
          `insert into event_versions (consumer, organization_id, aggregate_key, version)
           values ('storage-service__wiring-probe', $1, 'file:wiring-probe', 1)`,
          [atelierNordId],
        );
        await tx.client.query(
          `update event_versions set version = 2 where aggregate_key = 'file:wiring-probe'`,
        );
        await tx.client.query(
          `insert into idempotency_keys
             (organization_id, key, request_fingerprint, response_status, response_headers,
              expires_at)
           values ($1, 'wiring-probe', 'fingerprint', 201, '{}', now() + interval '1 day')`,
          [atelierNordId],
        );
        await tx.client.query(
          `insert into processed_events (consumer, event_id)
           values ('storage-service__wiring-probe', uuidv7())`,
        );
      }),
    );

    expect(await countAll(atelierNordId)).toEqual({
      outbox_events: 1,
      event_versions: 1,
      idempotency_keys: 1,
    });
    expect(await countAll(otherOrganizationId)).toEqual({
      outbox_events: 0,
      event_versions: 0,
      idempotency_keys: 0,
    });
    await expect(
      runWithOrganizationContext(memberOf(otherOrganizationId), () =>
        tenant.run((tx) =>
          tx.client.query(
            `insert into event_versions (consumer, organization_id, aggregate_key, version)
             values ('storage-service__wiring-probe', $1, 'file:wiring-probe-2', 1)`,
            [atelierNordId],
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const deleted = await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run(async (tx) => {
        const counts: number[] = [];
        for (const table of platformTables) {
          counts.push((await tx.client.query(`delete from ${table} returning 1`)).rows.length);
        }
        return counts;
      }),
    );
    expect(deleted).toEqual([1, 1, 1, 1]);
  });

  it('refuses any change of structure to the application role', async () => {
    const system = service().get(SystemTransactionRunner);
    const statements = [
      'create table wiring_probe (id integer)',
      'alter table outbox_events add column wiring_probe integer',
      'alter table outbox_events no force row level security',
      'drop table processed_events',
      'truncate idempotency_keys',
      'create schema wiring_probe',
    ];

    for (const statement of statements) {
      await expect(system.run((tx) => tx.client.query(statement))).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('keeps the migration journal out of reach of the application role', async () => {
    const system = service().get(SystemTransactionRunner);

    await expect(
      system.run((tx) => tx.client.query('delete from drizzle.__drizzle_migrations')),
    ).rejects.toMatchObject({ code: '42501', message: 'permission denied for schema drizzle' });

    const journal = await migrator.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );
    expect(journal.rows).toEqual([{ applied: 4 }]);
  });

  it('runs the outbox relay and marks an acknowledged event as sent', async () => {
    const tenant = service().get(TenantTransactionRunner);
    const eventId = randomUUID();
    await runWithOrganizationContext(memberOf(atelierNordId), () =>
      tenant.run((tx) =>
        tx.client.query(
          `insert into outbox_events (id, event_name, subject, stream, organization_id, payload)
           values ($2, 'file.wiring-probe.v1', 'evt.file.wiring-probe.v1', 'EVENTS', $1,
                   jsonb_build_object('id', $2::uuid::text, 'organizationId', $1::uuid::text))`,
          [atelierNordId, eventId],
        ),
      ),
    );

    await vi.waitFor(
      async () => {
        const result = await runWithOrganizationContext(memberOf(atelierNordId), () =>
          tenant.run((tx) =>
            tx.client.query(
              'select status, sent_at is not null as sent from outbox_events where id = $1',
              [eventId],
            ),
          ),
        );
        expect(result.rows[0]).toEqual({ status: 'sent', sent: true });
      },
      { timeout: 10_000, interval: 100 },
    );

    const response = await request(service().getHttpServer()).get('/health/ready');
    expect(response.status).toBe(200);
  });

  it('runs against a broker that enforces the permissions of cadenway-ops', () => {
    const storage = { NATS_USER: 'storage', NATS_PASSWORD: 'storage' };

    expect(
      brokerAccepts(storage, '--inbox-prefix', '_INBOX.storage', 'stream', 'info', 'EVENTS'),
    ).toBe(true);
    expect(brokerAccepts(storage, 'stream', 'info', 'EVENTS')).toBe(false);
    for (const name of [
      'claim-intake-attachment',
      'release-intake-attachment',
      'apply-avatar-change',
      'abandon-avatar-upload',
      'delete-avatar-owner',
      'apply-organization-logo-change',
      'abandon-organization-logo-upload',
    ]) {
      expect(
        brokerAccepts(
          storage,
          '--inbox-prefix',
          '_INBOX.storage',
          'consumer',
          'info',
          'EVENTS',
          `storage-service__${name}`,
        ),
      ).toBe(true);
    }
    expect(brokerAccepts(storage, 'pub', 'evt.intake.attachment-claimed.v1', 'refused')).toBe(
      false,
    );
    expect(brokerAccepts(storage, 'pub', 'evt.intake.attachment-released.v1', 'refused')).toBe(
      false,
    );
    expect(brokerAccepts(storage, 'pub', 'evt.user.avatar-changed.v1', 'refused')).toBe(false);
    expect(brokerAccepts(storage, 'pub', 'evt.organization.logo-changed.v1', 'refused')).toBe(
      false,
    );
    expect(brokerAccepts(storage, 'pub', 'evt.task.wiring-probe', 'refused')).toBe(false);
    expect(brokerAccepts({ NATS_USER: '', NATS_PASSWORD: '' }, 'pub', 'evt.file.x', 'x')).toBe(
      false,
    );
  });

  it('stops being ready while NATS is down, and is ready again once it is back', async () => {
    compose('stop', 'nats');

    await vi.waitFor(
      async () => {
        const response = await request(service().getHttpServer()).get('/health/ready');
        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
          status: 'error',
          info: { postgres: { status: 'up' } },
          error: { nats: { status: 'down' } },
        });
      },
      { timeout: 10_000, interval: 250 },
    );

    compose('start', 'nats');

    await vi.waitFor(
      async () => {
        const response = await request(service().getHttpServer()).get('/health/ready');
        expect(response.status).toBe(200);
      },
      { timeout: 30_000, interval: 500 },
    );
  });

  it('requeues only previously cleaned keys and advances the cursor under one live lease', async () => {
    const system = service().get<SystemTransactionRunner>(SystemTransactionRunner);
    const tenant = service().get(TenantTransactionRunner);
    const worker = new DrizzleAttachmentReconciliation(system);
    const peer = new DrizzleAttachmentReconciliation(system);
    const taskKey = 'REC-810';
    const known = `org/${atelierNordId}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b11`;
    const elected = `org/${atelierNordId}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b12`;
    const foreign = `org/${otherOrganizationId}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b13`;
    const unknown = `org/${atelierNordId}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b14`;
    const inventory = {
      objects: [known, elected, foreign, unknown].map((objectKey) => ({
        organizationId: atelierNordId,
        objectKey,
      })),
      next: 'next-page',
    };

    await system.run(async ({ client }) => {
      for (const row of [
        { key: known, organizationId: atelierNordId, status: 'cleaned' },
        { key: elected, organizationId: atelierNordId, status: 'elected' },
        { key: foreign, organizationId: otherOrganizationId, status: 'cleaned' },
      ]) {
        const id = randomUUID();
        await client.query(
          `insert into attachments
             (organization_id, id, task_key, author_user_id, object_key, staging_object_key,
              file_name, content_type, size_bytes, status, version, reserved_at, expires_at)
           values ($1, $2, $3, $4, $5, $5, 'sprint-14.png', 'image/png', 1, 'deleted', 1,
                   clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour')`,
          [row.organizationId, id, taskKey, camilleMartinId, row.key],
        );
        await client.query(
          `insert into attachment_candidates
             (organization_id, attachment_id, object_key, status, cleanup_after, cleanup_generation)
           values ($1, $2, $3, $4, clock_timestamp(), 4)`,
          [row.organizationId, id, row.key, row.status],
        );
      }
    });

    const removeFixtures = async (): Promise<void> => {
      await system.run(async ({ client }) => {
        await client.query('delete from attachment_candidates where object_key = any($1::text[])', [
          [known, elected, foreign],
        ]);
        await client.query(
          'delete from attachments where organization_id = any($1::uuid[]) and task_key = $2',
          [[atelierNordId, otherOrganizationId], taskKey],
        );
        await client.query("delete from attachment_reconciliation_cursors where scope = 'objects'");
      });
    };

    try {
      const claims = await Promise.all([worker.acquire(), peer.acquire()]);
      const active = claims.find((claim) => claim !== null);
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      if (active === undefined) throw new Error('The reconciliation lease was not acquired.');
      expect(active.continuation).toBeNull();

      const privateRows = await runWithOrganizationContext(memberOf(atelierNordId), () =>
        tenant.run(({ client }) =>
          client.query('select scope from attachment_reconciliation_cursors'),
        ),
      );
      expect(privateRows.rows).toEqual([]);
      await system.run(async ({ client }) => {
        await client.query(
          "update attachment_reconciliation_cursors set leased_until = clock_timestamp() - interval '1 second' where lease_id = $1",
          [active.id],
        );
      });
      const replacement = await peer.acquire();
      if (replacement === null)
        throw new Error('The expired reconciliation lease was not recovered.');
      expect(replacement.id).not.toBe(active.id);
      expect(await worker.complete(active.id, inventory)).toBeNull();
      await worker.release(active.id);
      expect(await worker.acquire()).toBeNull();

      await expect(
        system.run(async () => {
          expect(await peer.complete(replacement.id, inventory)).toBe(1);
          throw new Error('Reconciliation fixture rolled back.');
        }),
      ).rejects.toThrow('Reconciliation fixture rolled back.');
      expect(await worker.acquire()).toBeNull();

      await system.run(async ({ client }) => {
        const rolledBack = await client.query(
          'select status, cleanup_generation from attachment_candidates where organization_id = $1 and object_key = $2',
          [atelierNordId, known],
        );
        expect(rolledBack.rows).toEqual([{ status: 'cleaned', cleanup_generation: 4 }]);
        expect(await peer.complete(replacement.id, inventory)).toBe(1);
        const rows = await client.query(
          'select object_key, status, cleanup_generation from attachment_candidates where object_key = any($1::text[])',
          [[known, elected, foreign, unknown]],
        );
        expect(rows.rows).toHaveLength(3);
        expect(rows.rows).toEqual(
          expect.arrayContaining([
            { object_key: known, status: 'fenced', cleanup_generation: 5 },
            { object_key: elected, status: 'elected', cleanup_generation: 4 },
            { object_key: foreign, status: 'cleaned', cleanup_generation: 4 },
          ]),
        );
        await client.query(
          'delete from attachment_candidates where organization_id = $1 and object_key = $2',
          [atelierNordId, known],
        );
      });
      const next = await worker.acquire();
      if (next === null) throw new Error('The completed reconciliation lease was not released.');
      expect(next.continuation).toBe('next-page');
      expect(await worker.complete(next.id, { objects: [], next: null })).toBe(0);
      expect(await peer.acquire()).toMatchObject({ continuation: null });
    } finally {
      await removeFixtures();
    }
  });

  it('stops being ready when its database is down', async () => {
    compose('stop', 'postgres');

    const response = await request(service().getHttpServer()).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'error',
      error: { postgres: { status: 'down' } },
    });
  });

  it('answers 503 on readiness and 200 on liveness as soon as it shuts down', async () => {
    const running = service();
    const closing = running.close();

    await vi.waitFor(
      async () => {
        const response = await request(running.getHttpServer()).get('/health/ready');
        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
          error: { shutdown: { status: 'down', message: 'shutting down' } },
        });
      },
      { timeout: 5_000, interval: 50 },
    );
    const live = await request(running.getHttpServer()).get('/health/live');
    expect(live.status).toBe(200);

    releaseShutdown();
    await closing;
    app = undefined;
  });
});
