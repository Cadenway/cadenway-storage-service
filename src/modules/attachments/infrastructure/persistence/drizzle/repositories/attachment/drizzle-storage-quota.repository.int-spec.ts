import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { runWithOrganizationContext } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AttachmentUnitOfWork } from '../../../../../application/ports/outbound/transactions/attachment/attachment-unit-of-work.port.js';
import { ApplyStorageEntitlement } from '../../../../../application/use-cases/commands/attachment/apply-storage-entitlement/apply-storage-entitlement.use-case.js';
import { DrizzleAttachmentTransaction } from './drizzle-attachment-transaction.repository.js';
import { DrizzleAttachmentCleanupTransaction } from './drizzle-attachment-cleanup-transaction.repository.js';
import { DrizzleIntakeAttachmentCleanupTransaction } from './drizzle-intake-attachment-cleanup-transaction.repository.js';
import { DrizzleIntakeAttachmentTransaction } from './drizzle-intake-attachment-transaction.repository.js';

const project = `cadenway-storage-quota-test-${String(process.pid)}`;
const composeFile = resolve('compose.dev.yaml');
const organizationId = '01938f6e-0000-7000-8000-000000000001';
const otherOrganizationId = '01938f6e-0000-7000-8000-000000000002';
const publicationId = '01938f6e-0000-7000-8000-000000000003';
const actorId = '01938f6e-0000-7000-8000-000000000004';

function compose(...args: readonly string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--project-name', project, '--file', composeFile, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, DEV_POSTGRES_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function inOrganization<T>(id: string, work: () => Promise<T>): Promise<T> {
  return runWithOrganizationContext(
    { organizationId: id, actor: { type: 'user', id: actorId }, role: null, scopes: [] },
    work,
  );
}

function deferred<Value>() {
  let finish: (value: Value) => void = () => {
    throw new Error('Deferred promise has no resolver.');
  };
  const promise = new Promise<Value>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

describe('storage verified byte admission', () => {
  let pool: pg.Pool | undefined;
  let tenant: TenantTransactionRunner;

  beforeAll(async () => {
    compose('up', '--detach', '--wait', '--wait-timeout', '120', 'postgres');
    const port = compose('port', 'postgres', '5432').trim().split(':').at(-1);
    if (port === undefined) throw new Error('PostgreSQL port is unavailable.');
    const migrator = new pg.Pool({
      connectionString: `postgres://storage_migrator:storage_migrator@127.0.0.1:${port}/storage`,
    });
    try {
      await migrate(drizzle({ client: migrator }), { migrationsFolder: resolve('migrations') });
    } finally {
      await migrator.end();
    }
    pool = new pg.Pool({
      connectionString: `postgres://storage_app:storage_app@127.0.0.1:${port}/storage`,
    });
    tenant = new TenantTransactionRunner(pool);
  });

  afterAll(async () => {
    await pool?.end();
    compose('down', '--volumes', '--remove-orphans');
  });

  it('accounts for live staging across both upload paths until the signed deadline', async () => {
    const tenantId = randomUUID();
    const attachmentId = randomUUID();
    const intakeId = randomUUID();
    await inOrganization(tenantId, () =>
      tenant.run(async (scope) => {
        await scope.client.query(
          `insert into attachments
             (organization_id, id, task_key, author_user_id, object_key, staging_object_key,
              file_name, content_type, size_bytes, status, scan_status, version, reserved_at, expires_at)
           values ($1, $2, 'CAD-1', $3, 'normal-object', 'normal-staging',
                   'normal.txt', 'text/plain', 10, 'ready', 'verified', 1, now(),
                   now() + interval '5 minutes')`,
          [tenantId, attachmentId, actorId],
        );
        await scope.client.query(
          `insert into attachment_candidates
             (organization_id, attachment_id, object_key, status, cleanup_after, retention)
           values ($1, $2, 'normal-staging', 'staging', now() + interval '5 minutes', 'transient'),
                  ($1, $2, 'expired-staging', 'staging', now() - interval '1 minute', 'transient')`,
          [tenantId, attachmentId],
        );
        await scope.client.query(
          `insert into intake_attachments
             (organization_id, publication_id, id, status, staging_object_key, file_name,
              content_type, size_bytes, reserved_at, expires_at, upload_expires_at)
           values ($1, $2, $3, 'pending', 'intake-staging', 'intake.txt', 'text/plain', 20,
                   now(), now() + interval '1 day', now() + interval '4 minutes')`,
          [tenantId, publicationId, intakeId],
        );
        await scope.client.query(
          `insert into intake_attachment_candidates
             (organization_id, publication_id, attachment_id, object_key, status, cleanup_after,
              retention, staging_bytes)
           values ($1, $2, $3, 'intake-staging', 'staging', now() + interval '4 minutes', 'transient', 20)`,
          [tenantId, publicationId, intakeId],
        );
        const transaction = new DrizzleAttachmentTransaction(scope, tenantId, vi.fn(), undefined);
        await expect(transaction.lockAndReadStorageAdmission()).resolves.toMatchObject({
          usedBytes: 10n,
        });
        await expect(transaction.lockAndReadStorageAdmission(true)).resolves.toMatchObject({
          usedBytes: 40n,
        });
        await scope.client.query(
          `update intake_attachments
           set status = 'released', staging_object_key = null, file_name = null, content_type = null,
               size_bytes = null, reserved_at = null, expires_at = null, upload_expires_at = null,
               decided_at = now()
           where organization_id = $1 and publication_id = $2 and id = $3`,
          [tenantId, publicationId, intakeId],
        );
        await expect(transaction.lockAndReadStorageAdmission(true)).resolves.toMatchObject({
          usedBytes: 40n,
        });
        await scope.client.query(
          `update intake_attachment_candidates
           set staging_bytes = null
           where organization_id = $1 and publication_id = $2 and attachment_id = $3`,
          [tenantId, publicationId, intakeId],
        );
        await expect(transaction.lockAndReadStorageAdmission(true)).resolves.toMatchObject({
          usedBytes: 20n + 25n * 1024n * 1024n,
        });
        await scope.client.query(
          `update intake_attachment_candidates
           set cleanup_after = now() - interval '1 minute'
           where organization_id = $1 and publication_id = $2 and attachment_id = $3`,
          [tenantId, publicationId, intakeId],
        );
        await expect(transaction.lockAndReadStorageAdmission(true)).resolves.toMatchObject({
          usedBytes: 20n,
        });
      }),
    );
  });

  it('schedules only the refused copies for cleanup before their reservations expire', async () => {
    const normalId = '01938f6e-0000-7000-8000-000000000005';
    const intakeId = '01938f6e-0000-7000-8000-000000000006';
    const identity = { organizationId, publicationId, attachmentId: intakeId };
    const keys = ['normal-rejected', 'normal-sibling', 'normal-elected'];
    const intakeKeys = ['intake-rejected', 'intake-sibling', 'intake-elected'];
    const insert = (tenantId: string): Promise<void> =>
      inOrganization(tenantId, () =>
        tenant.run(async (scope) => {
          await scope.client.query(
            `insert into attachments
             (organization_id, id, task_key, author_user_id, object_key, staging_object_key,
              file_name, content_type, size_bytes, status, scan_status, version, reserved_at, expires_at)
             values ($1, $2, 'CAD-482', $3, 'org/' || $1::uuid::text || '/' || $2::uuid::text,
                     'org/' || $1::uuid::text || '/01938f6e-0000-7000-8000-000000000007',
                     'normal.txt', 'text/plain', 10, 'pending', 'pending', 0, now(), now() + interval '1 day')`,
            [tenantId, normalId, actorId],
          );
          await scope.client.query(
            `insert into intake_attachments
             (organization_id, publication_id, id, status, staging_object_key, file_name,
              content_type, size_bytes, reserved_at, expires_at, upload_expires_at)
             values ($1, $2, $3, 'pending', 'intake/01938f6e-0000-7000-8000-000000000008', 'intake.txt', 'text/plain', 10,
                     now(), now() + interval '1 day', now() + interval '4 minutes')`,
            [tenantId, publicationId, intakeId],
          );
          for (const [index, key] of keys.entries()) {
            await scope.client.query(
              `insert into attachment_candidates (organization_id, attachment_id, object_key, status, cleanup_after, retention)
               values ($1, $2, $3, $4, now() + interval '1 day', $5)`,
              [
                tenantId,
                normalId,
                key,
                index === 0 ? 'cleaned' : index === 1 ? 'active' : 'elected',
                index === 2 ? 'preserve' : 'candidate',
              ],
            );
          }
          for (const [index, key] of intakeKeys.entries()) {
            await scope.client.query(
              `insert into intake_attachment_candidates
               (organization_id, publication_id, attachment_id, object_key, status, cleanup_after, retention)
               values ($1, $2, $3, $4, $5, now() + interval '1 day', $6)`,
              [
                tenantId,
                publicationId,
                intakeId,
                key,
                index === 0 ? 'fenced' : index === 1 ? 'active' : 'elected',
                index === 2 ? 'preserve' : 'candidate',
              ],
            );
          }
        }),
      );
    await insert(organizationId);
    await insert(otherOrganizationId);

    await inOrganization(organizationId, () =>
      tenant.run(async (scope) => {
        const normal = new DrizzleAttachmentTransaction(scope, organizationId, vi.fn(), undefined);
        const intake = new DrizzleIntakeAttachmentTransaction(
          scope,
          organizationId,
          vi.fn(),
          vi.fn(),
          undefined,
        );
        await intake.lock(identity);
        await normal.scheduleCandidateCleanup(normalId, 'normal-rejected');
        await normal.scheduleCandidateCleanup(normalId, 'normal-elected');
        await intake.scheduleCandidateCleanup(identity, 'intake-rejected');
        await intake.scheduleCandidateCleanup(identity, 'intake-elected');
      }),
    );
    for (const tenantId of [organizationId, otherOrganizationId]) {
      const result = await inOrganization(tenantId, () =>
        tenant.run(async (scope) => {
          const normal = new DrizzleAttachmentCleanupTransaction(scope, tenantId, vi.fn());
          const intake = new DrizzleIntakeAttachmentCleanupTransaction(scope, tenantId);
          const cutoff = new Date();
          return {
            normal: await normal.fenceDueObjects(cutoff, null, 100),
            intake: await intake.fenceDueObjects(cutoff, null, 100),
          };
        }),
      );
      expect(result.normal.objects.map(({ objectKey }) => objectKey)).toEqual(
        tenantId === organizationId ? ['normal-rejected'] : [],
      );
      expect(result.intake.objects.map(({ objectKey }) => objectKey)).toEqual(
        tenantId === organizationId ? ['intake-rejected'] : [],
      );
      if (tenantId === organizationId) {
        expect(result.normal.objects[0]?.retention).toBe('transient');
        expect(result.intake.objects[0]?.retention).toBe('transient');
      }
    }
  });

  it('serializes a normal and an Intake completion for the final bytes', async () => {
    const attachmentId = randomUUID();
    const intakeId = randomUUID();
    const normal = inOrganization(organizationId, () =>
      tenant.run(async (scope) => {
        const transaction = new DrizzleAttachmentTransaction(
          scope,
          organizationId,
          vi.fn().mockResolvedValue(undefined),
          undefined,
        );
        const { usedBytes } = await transaction.lockAndReadStorageAdmission();
        if (usedBytes + 10n > 10n) return false;
        await scope.client.query(
          `insert into attachments
             (organization_id, id, task_key, author_user_id, object_key, staging_object_key,
              file_name, content_type, size_bytes, status, scan_status, version, reserved_at, expires_at)
           values ($1, $2, 'CAD-1', $3, 'normal-object', 'normal-staging',
                   'normal.txt', 'text/plain', 10, 'ready', 'verified', 1, now(), now())`,
          [organizationId, attachmentId, actorId],
        );
        return true;
      }),
    );
    const intake = inOrganization(organizationId, () =>
      tenant.run(async (scope) => {
        const transaction = new DrizzleIntakeAttachmentTransaction(
          scope,
          organizationId,
          vi.fn().mockResolvedValue(undefined),
          vi.fn().mockResolvedValue(undefined),
          undefined,
        );
        const { usedBytes } = await transaction.lockAndReadStorageAdmission();
        if (usedBytes + 10n > 10n) return false;
        await scope.client.query(
          `insert into intake_attachments
             (organization_id, publication_id, id, status, staging_object_key, file_name,
              content_type, size_bytes, reserved_at, expires_at, upload_expires_at, candidate_key, verified_at)
           values ($1, $2, $3, 'verified', 'intake-staging', 'intake.txt',
                   'text/plain', 10, now(), now(), now(), 'intake-candidate', now())`,
          [organizationId, publicationId, intakeId],
        );
        return true;
      }),
    );
    expect((await Promise.all([normal, intake])).sort()).toEqual([false, true]);

    const totals = (id: string): Promise<bigint> =>
      inOrganization(id, () =>
        tenant.run(async (scope) => {
          const transaction = new DrizzleAttachmentTransaction(
            scope,
            id,
            vi.fn().mockResolvedValue(undefined),
            undefined,
          );
          return (await transaction.lockAndReadStorageAdmission()).usedBytes;
        }),
      );
    await expect(totals(organizationId)).resolves.toBe(10n);
    await expect(totals(otherOrganizationId)).resolves.toBe(0n);
  });

  it('rejects a stronger isolation level that could retain a pre-lock snapshot', async () => {
    await expect(
      inOrganization(organizationId, () =>
        tenant.run(
          async (scope) => {
            const transaction = new DrizzleAttachmentTransaction(
              scope,
              organizationId,
              vi.fn().mockResolvedValue(undefined),
              undefined,
            );
            return transaction.lockAndReadStorageAdmission();
          },
          { isolationLevel: 'repeatable read' },
        ),
      ),
    ).rejects.toThrow('Storage quota admission requires a read committed transaction.');
  });

  it('projects a canonical Free downgrade once and preserves existing attachments and reservations', async () => {
    const upgradedOrganization = randomUUID();
    const freeOrganization = randomUUID();
    const work: AttachmentUnitOfWork = {
      run: (id, operation) =>
        inOrganization(id, () =>
          tenant.run((scope) =>
            operation(
              new DrizzleAttachmentTransaction(
                scope,
                id,
                vi.fn().mockResolvedValue(undefined),
                undefined,
              ),
            ),
          ),
        ),
    };
    const applyEntitlement = new ApplyStorageEntitlement(work);
    const apply = (version: number, limitBytes: bigint, plan = 'team', seatLimit = 5) =>
      applyEntitlement.execute({
        organizationId: upgradedOrganization,
        version,
        limitBytes,
        plan,
        seatLimit,
      });

    await expect(apply(1, 1_999_999_999n)).resolves.toBe('invalid');
    await expect(apply(2, 3_000_000_000n)).resolves.toBe('applied');
    await expect(apply(2, 3_000_000_000n)).resolves.toBe('unchanged');
    await expect(apply(2, 4_000_000_000n)).resolves.toBe('conflict');
    await expect(apply(1, 4_000_000_000n)).resolves.toBe('stale');
    await expect(apply(3, 2_000_000_000n)).resolves.toBe('decrease');
    await expect(apply(3, 2_000_000_000n, 'free', 6)).resolves.toBe('invalid');

    const intakeId = randomUUID();
    await inOrganization(upgradedOrganization, () =>
      tenant.run(async (scope) => {
        await scope.client.query(
          `insert into attachments
             (organization_id, id, task_key, author_user_id, object_key, staging_object_key,
              file_name, content_type, size_bytes, status, scan_status, version, reserved_at, expires_at)
           select $1, uuidv7(), 'CAD-482', $2, 'ready-' || position, 'staging-' || position,
                  'ready.txt', 'text/plain', 25000000, 'ready', 'verified', 1, now(), now()
             from generate_series(1, 80) as position`,
          [upgradedOrganization, actorId],
        );
        await scope.client.query(
          `insert into intake_attachments
             (organization_id, publication_id, id, status, staging_object_key, file_name,
              content_type, size_bytes, reserved_at, expires_at, upload_expires_at, candidate_key, verified_at)
           values ($1, $2, $3, 'verified', 'free-intake-staging', 'intake.txt',
                   'text/plain', 7, now(), now(), now(), 'free-intake-candidate', now())`,
          [upgradedOrganization, publicationId, intakeId],
        );
      }),
    );

    await expect(apply(3, 2_000_000_000n, 'free')).resolves.toBe('applied');
    await expect(apply(3, 2_000_000_000n, 'free')).resolves.toBe('unchanged');
    await expect(apply(3, 3_000_000_000n)).resolves.toBe('conflict');
    await expect(apply(2, 3_000_000_000n)).resolves.toBe('stale');

    await expect(
      work.run(upgradedOrganization, (tx) => tx.lockAndReadStorageEntitlement()),
    ).resolves.toEqual({ version: 3, limitBytes: 2_000_000_000n });
    await expect(
      work.run(upgradedOrganization, (tx) => tx.lockAndReadStorageAdmission()),
    ).resolves.toEqual({ usedBytes: 2_000_000_007n, limitBytes: 2_000_000_000n });
    const preserved = await inOrganization(upgradedOrganization, () =>
      tenant.run((scope) =>
        scope.client.query(
          `select
             (select count(*) from attachments where organization_id = $1 and status = 'ready') as ready,
             (select count(*) from intake_attachments
               where organization_id = $1 and id = $2 and status = 'verified') as verified`,
          [upgradedOrganization, intakeId],
        ),
      ),
    );
    expect(preserved.rows).toEqual([{ ready: '80', verified: '1' }]);
    await expect(
      work.run(freeOrganization, (tx) => tx.lockAndReadStorageEntitlement()),
    ).resolves.toEqual({ version: 0, limitBytes: 2_000_000_000n });
    await expect(
      inOrganization(freeOrganization, () =>
        tenant.run((scope) =>
          scope.client.query(
            'insert into storage_byte_entitlements (organization_id, version, limit_bytes) values ($1, 4, 4000000000)',
            [upgradedOrganization],
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('reads the reduced byte limit after Intake waits for a concurrent entitlement update', async () => {
    const upgradedOrganization = randomUUID();
    const written = deferred<undefined>();
    const commit = deferred<undefined>();
    await inOrganization(upgradedOrganization, () =>
      tenant.run(async (scope) => {
        const transaction = new DrizzleAttachmentTransaction(
          scope,
          upgradedOrganization,
          vi.fn().mockResolvedValue(undefined),
          undefined,
        );
        await transaction.lockAndReadStorageEntitlement();
        await transaction.saveStorageEntitlement({ version: 1, limitBytes: 3_000_000_000n });
      }),
    );
    const writer = inOrganization(upgradedOrganization, () =>
      tenant.run(async (scope) => {
        const transaction = new DrizzleAttachmentTransaction(
          scope,
          upgradedOrganization,
          vi.fn().mockResolvedValue(undefined),
          undefined,
        );
        await transaction.lockAndReadStorageEntitlement();
        await transaction.saveStorageEntitlement({ version: 2, limitBytes: 2_000_000_000n });
        written.finish(undefined);
        await commit.promise;
      }),
    );
    await Promise.race([written.promise, writer]);

    const readerPid = deferred<number>();
    const reader = inOrganization(upgradedOrganization, () =>
      tenant.run(async (scope) => {
        const result = await scope.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        const pid = result.rows[0]?.pid;
        if (pid === undefined) throw new Error('The Intake session has no backend PID.');
        readerPid.finish(pid);
        const transaction = new DrizzleIntakeAttachmentTransaction(
          scope,
          upgradedOrganization,
          vi.fn().mockResolvedValue(undefined),
          vi.fn().mockResolvedValue(undefined),
          undefined,
        );
        return transaction.lockAndReadStorageAdmission();
      }),
    );
    try {
      const pid = await Promise.race([readerPid.promise, reader.then(() => undefined)]);
      await vi.waitFor(
        async () => {
          const result = await pool?.query(
            "select 1 from pg_locks where pid = $1 and locktype = 'advisory' and not granted",
            [pid],
          );
          expect(result?.rowCount).toBe(1);
        },
        { timeout: 3_000 },
      );
    } finally {
      commit.finish(undefined);
      await writer;
    }
    await expect(reader).resolves.toEqual({ usedBytes: 0n, limitBytes: 2_000_000_000n });
  });

  it('counts an expired verified Intake reservation until its terminal release', async () => {
    const intakeId = randomUUID();
    await inOrganization(otherOrganizationId, () =>
      tenant.run(async (scope) => {
        await scope.client.query(
          `insert into intake_attachments
             (organization_id, publication_id, id, status, staging_object_key, file_name,
              content_type, size_bytes, reserved_at, expires_at, upload_expires_at, candidate_key, verified_at)
           values ($1, $2, $3, 'verified', 'old-staging', 'old.txt', 'text/plain', 7,
                   now() - interval '2 days', now() - interval '1 day', now() - interval '1 day',
                   'old-candidate', now() - interval '1 day')`,
          [otherOrganizationId, publicationId, intakeId],
        );
      }),
    );
    const currentBytes = (): Promise<bigint> =>
      inOrganization(otherOrganizationId, () =>
        tenant.run(async (scope) => {
          const transaction = new DrizzleAttachmentTransaction(
            scope,
            otherOrganizationId,
            vi.fn().mockResolvedValue(undefined),
            undefined,
          );
          return (await transaction.lockAndReadStorageAdmission()).usedBytes;
        }),
      );
    await expect(currentBytes()).resolves.toBe(7n);
    await inOrganization(otherOrganizationId, () =>
      tenant.run(async (scope) => {
        await scope.client.query(
          `update intake_attachments
              set status = 'released', staging_object_key = null, file_name = null,
                  content_type = null, size_bytes = null, reserved_at = null, expires_at = null,
                  upload_expires_at = null, candidate_key = null, verified_at = null, decided_at = now()
            where organization_id = $1 and publication_id = $2 and id = $3`,
          [otherOrganizationId, publicationId, intakeId],
        );
      }),
    );
    await expect(currentBytes()).resolves.toBe(0n);
  });
});
