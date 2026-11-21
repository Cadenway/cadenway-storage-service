import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { runWithOrganizationContext } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DrizzleAttachmentTransaction } from './drizzle-attachment-transaction.repository.js';
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
        const used = await transaction.lockAndReadVerifiedBytes();
        if (used + 10n > 10n) return false;
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
        const used = await transaction.lockAndReadVerifiedBytes();
        if (used + 10n > 10n) return false;
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
          return transaction.lockAndReadVerifiedBytes();
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
            return transaction.lockAndReadVerifiedBytes();
          },
          { isolationLevel: 'repeatable read' },
        ),
      ),
    ).rejects.toThrow('Storage quota admission requires a read committed transaction.');
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
          return transaction.lockAndReadVerifiedBytes();
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
