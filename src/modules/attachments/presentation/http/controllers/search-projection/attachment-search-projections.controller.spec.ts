import { generateKeyPairSync } from 'node:crypto';

import { createApplication, InternalTokenSigner } from '@cadenway/nest-common';
import type { Ed25519PublicJwk } from '@cadenway/nest-common';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureSearchProjectionNoStore } from '../../../../../../infrastructure/http/no-store-search-projections.middleware.js';
import { AttachmentSearchProjectionError } from '../../../../application/models/search-projection/attachment-search-projection-error.model.js';
import { ListAttachmentSearchProjections } from '../../../../application/use-cases/queries/search-projection/list-attachment-search-projections/list-attachment-search-projections.use-case.js';
import { ResolveAttachmentSearchProjections } from '../../../../application/use-cases/queries/search-projection/resolve-attachment-search-projections/resolve-attachment-search-projections.use-case.js';
import { AttachmentSearchProjectionsController } from './attachment-search-projections.controller.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const presentId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f11';
const absentId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f12';
const route = '/internal/v1/attachment-search-projections';
const projection = { fileId: presentId, taskKey: 'TASK-1', fileName: 'report.pdf', version: 2 };
const privateRow = { ...projection, candidateKey: 'fixture-only-private-field' };
const list = vi.fn<ListAttachmentSearchProjections['execute']>();
const resolve = vi.fn<ResolveAttachmentSearchProjections['execute']>();

/** Hosts the routes with the real guard, parser and validators. */
@Module({
  controllers: [AttachmentSearchProjectionsController],
  providers: [
    { provide: ListAttachmentSearchProjections, useValue: { execute: list } },
    { provide: ResolveAttachmentSearchProjections, useValue: { execute: resolve } },
  ],
})
class AttachmentSearchProjectionsRouteModule {}

async function signerFor(
  issuer: string,
): Promise<{ readonly signer: InternalTokenSigner; readonly publicJwk: Ed25519PublicJwk }> {
  const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  if (x === undefined || d === undefined) throw new Error('The test key could not be generated.');
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', kid: issuer, x };
  const signer = await InternalTokenSigner.create({ issuer, privateJwk: { ...publicJwk, d } });
  return { signer, publicJwk };
}

describe('AttachmentSearchProjectionsController', () => {
  let app: NestExpressApplication;
  let authorization: string;
  let wrongActor: string;
  let missingTenant: string;
  let otherIssuer: string;

  beforeAll(async () => {
    const [search, task] = await Promise.all([
      signerFor('search-service'),
      signerFor('task-service'),
    ]);
    const claims = { organizationId, actor: { type: 'system', id: 'search-service' } } as const;
    const [validToken, wrongActorToken, missingTenantToken, otherIssuerToken] = await Promise.all([
      search.signer.sign('storage-service', claims),
      search.signer.sign('storage-service', {
        ...claims,
        actor: { type: 'system', id: 'other-worker' },
      }),
      search.signer.sign('storage-service', { ...claims, organizationId: null }),
      task.signer.sign('storage-service', claims),
    ]);
    authorization = `Bearer ${validToken}`;
    wrongActor = `Bearer ${wrongActorToken}`;
    missingTenant = `Bearer ${missingTenantToken}`;
    otherIssuer = `Bearer ${otherIssuerToken}`;
    app = await createApplication(AttachmentSearchProjectionsRouteModule, {
      service: 'storage-service',
      config: { LOG_LEVEL: 'silent' },
      internalToken: {
        verifier: {
          audience: 'storage-service',
          trustedIssuers: {
            'search-service': [search.publicJwk],
            'task-service': [task.publicJwk],
          },
        },
      },
    });
    configureSearchProjectionNoStore(app);
    await app.init();
  });

  beforeEach(() => {
    list.mockReset().mockResolvedValue({ items: [privateRow], nextCursor: null });
    resolve.mockReset().mockResolvedValue({
      results: [
        { status: 'absent', fileId: absentId, version: null },
        { status: 'present', projection: privateRow },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('uses the signed tenant and emits only the published export fields', async () => {
    const result = await request(app.getHttpServer())
      .get(route)
      .set('Authorization', authorization);

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({ items: [projection], nextCursor: null });
    expect(list).toHaveBeenCalledExactlyOnceWith({ organizationId, cursor: null, limit: 50 });
  });

  it('canonicalizes UUIDs and relays only ordered projection decisions', async () => {
    const result = await request(app.getHttpServer())
      .post(`${route}/resolve`)
      .set('Authorization', authorization)
      .send({ fileIds: [absentId.toUpperCase(), presentId] });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      results: [
        { status: 'absent', fileId: absentId, version: null },
        { status: 'present', projection },
      ],
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      organizationId,
      fileIds: [absentId, presentId],
    });
  });

  it('rejects invalid, unscoped and foreign credentials before serving projections', async () => {
    const refusals = [
      ['', 401, 'auth.token-missing'],
      ['Bearer invalid', 401, 'auth.token-invalid'],
      [wrongActor, 403, 'auth.actor-not-allowed'],
      [missingTenant, 403, 'auth.organization-required'],
      [otherIssuer, 403, 'auth.issuer-not-allowed'],
    ] as const;
    for (const [token, status, code] of refusals) {
      const call = request(app.getHttpServer()).get(route);
      if (token !== '') call.set('Authorization', token);
      const result = await call;
      expect(result.status).toBe(status);
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.body).toMatchObject({ status, code });
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects repeated UUIDs regardless of case and additional body fields', async () => {
    const invalid = [
      { fileIds: [presentId, presentId.toUpperCase()] },
      { fileIds: [presentId], organizationId },
      { fileIds: [] },
    ];
    for (const body of invalid) {
      const result = await request(app.getHttpServer())
        .post(`${route}/resolve`)
        .set('Authorization', authorization)
        .send(body);
      expect(result.status).toBe(400);
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.body).toMatchObject({ code: 'request.invalid' });
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('applies no-store to parser errors', async () => {
    const result = await request(app.getHttpServer())
      .post(`${route}/resolve`)
      .set('Authorization', authorization)
      .set('Content-Type', 'application/json')
      .send('{"fileIds":');

    expect(result.status).toBe(400);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('bounds the query and reports bad continuations without returning their contents', async () => {
    list.mockRejectedValue(new AttachmentSearchProjectionError('invalid-cursor'));
    const excessive = await request(app.getHttpServer())
      .get(route)
      .set('Authorization', authorization)
      .query({ limit: 101 });
    const invalid = await request(app.getHttpServer())
      .get(route)
      .set('Authorization', authorization)
      .query({ limit: 1, cursor: 'fixture-opaque-value' });

    expect(excessive.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(invalid.headers['cache-control']).toBe('private, no-store');
    expect(invalid.body).toMatchObject({
      code: 'request.invalid',
      details: { issues: [{ in: 'query', path: 'cursor' }] },
    });
    expect(JSON.stringify(invalid.body)).not.toContain('fixture-opaque-value');
    expect(list).toHaveBeenCalledExactlyOnceWith({
      organizationId,
      cursor: 'fixture-opaque-value',
      limit: 1,
    });
  });

  it('fails the entire resolve operation when the reader fails', async () => {
    resolve.mockRejectedValue(new Error('private persistence details'));
    const result = await request(app.getHttpServer())
      .post(`${route}/resolve`)
      .set('Authorization', authorization)
      .send({ fileIds: [absentId, presentId] });

    expect(result.status).toBe(503);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toMatchObject({ code: 'storage.unavailable' });
    expect(JSON.stringify(result.body)).not.toContain('private persistence details');
  });
});
