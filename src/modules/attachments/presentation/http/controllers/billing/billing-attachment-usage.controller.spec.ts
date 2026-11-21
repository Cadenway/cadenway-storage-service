import { generateKeyPairSync } from 'node:crypto';

import { createApplication, InternalTokenSigner } from '@cadenway/nest-common';
import type { Ed25519PublicJwk } from '@cadenway/nest-common';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureSearchProjectionNoStore } from '../../../../../../infrastructure/http/no-store-search-projections.middleware.js';
import { BillingAttachmentUsageError } from '../../../../application/models/billing/billing-attachment-usage-error.model.js';
import { ListBillingAttachmentUsage } from '../../../../application/use-cases/queries/billing/list-billing-attachment-usage/list-billing-attachment-usage.use-case.js';
import { BillingAttachmentUsageController } from './billing-attachment-usage.controller.js';

const route = '/internal/v1/billing-attachment-usage';
const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const fileId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
const list = vi.fn<ListBillingAttachmentUsage['execute']>();

/** Hosts the endpoint with the real internal-token guard and generated validators. */
@Module({
  controllers: [BillingAttachmentUsageController],
  providers: [{ provide: ListBillingAttachmentUsage, useValue: { execute: list } }],
})
class BillingAttachmentUsageRouteModule {}

async function signerFor(
  issuer: string,
): Promise<{ readonly signer: InternalTokenSigner; readonly publicJwk: Ed25519PublicJwk }> {
  const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  if (x === undefined || d === undefined) throw new Error('The test key could not be generated.');
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', kid: issuer, x };
  const signer = await InternalTokenSigner.create({ issuer, privateJwk: { ...publicJwk, d } });
  return { signer, publicJwk };
}

describe('BillingAttachmentUsageController', () => {
  let app: NestExpressApplication;
  let authorization: string;
  let wrongActor: string;
  let missingTenant: string;
  let otherIssuer: string;

  beforeAll(async () => {
    const [billing, search] = await Promise.all([
      signerFor('billing-service'),
      signerFor('search-service'),
    ]);
    const claims = { organizationId, actor: { type: 'system', id: 'billing-service' } } as const;
    const [validToken, wrongActorToken, missingTenantToken, otherIssuerToken] = await Promise.all([
      billing.signer.sign('storage-service', claims),
      billing.signer.sign('storage-service', {
        ...claims,
        actor: { type: 'system', id: 'other-worker' },
      }),
      billing.signer.sign('storage-service', { ...claims, organizationId: null }),
      search.signer.sign('storage-service', claims),
    ]);
    authorization = `Bearer ${validToken}`;
    wrongActor = `Bearer ${wrongActorToken}`;
    missingTenant = `Bearer ${missingTenantToken}`;
    otherIssuer = `Bearer ${otherIssuerToken}`;
    app = await createApplication(BillingAttachmentUsageRouteModule, {
      service: 'storage-service',
      config: { LOG_LEVEL: 'silent' },
      internalToken: {
        verifier: {
          audience: 'storage-service',
          trustedIssuers: {
            'billing-service': [billing.publicJwk],
            'search-service': [search.publicJwk],
          },
        },
      },
    });
    configureSearchProjectionNoStore(app);
    await app.init();
  });

  beforeEach(() => {
    list.mockReset().mockResolvedValue({
      items: [{ fileId, state: 'ready', sizeBytes: 248320, version: 1 }],
      nextCursor: null,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('uses the signed tenant and emits only published fields', async () => {
    const privateRow = {
      fileId,
      state: 'ready',
      sizeBytes: 248320,
      version: 1,
      secret: 'private',
    } as const;
    list.mockResolvedValue({
      items: [privateRow],
      nextCursor: null,
    });
    const result = await request(app.getHttpServer())
      .get(route)
      .set('Authorization', authorization);

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      items: [{ fileId, state: 'ready', sizeBytes: 248320, version: 1 }],
      nextCursor: null,
    });
    expect(list).toHaveBeenCalledExactlyOnceWith({ organizationId, cursor: null, limit: 50 });
  });

  it('rejects invalid, unscoped and foreign credentials', async () => {
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

  it('bounds queries and redacts malformed cursors', async () => {
    list.mockRejectedValue(new BillingAttachmentUsageError('invalid-cursor'));
    const excessive = await request(app.getHttpServer())
      .get(route)
      .set('Authorization', authorization)
      .query({ limit: 101 });
    const invalid = await request(app.getHttpServer())
      .get(route)
      .set('Authorization', authorization)
      .query({ cursor: 'fixture-private-cursor', limit: 1 });

    expect(excessive.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      code: 'request.invalid',
      details: { issues: [{ in: 'query', path: 'cursor' }] },
    });
    expect(JSON.stringify(invalid.body)).not.toContain('fixture-private-cursor');
    expect(list).toHaveBeenCalledExactlyOnceWith({
      organizationId,
      cursor: 'fixture-private-cursor',
      limit: 1,
    });
  });

  it('maps unexpected failures to an unavailable response', async () => {
    list.mockRejectedValue(new Error('fixture-private-detail'));
    const result = await request(app.getHttpServer())
      .get(route)
      .set('Authorization', authorization);

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ code: 'storage.unavailable' });
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-detail');
  });

  it('applies the cache policy before the parser and serves a fresh conditional page', async () => {
    const malformed = await request(app.getHttpServer())
      .get(route)
      .set('Authorization', authorization)
      .set('Content-Type', 'application/json')
      .send('{');
    expect(malformed.status).toBe(400);
    expect(malformed.headers['cache-control']).toBe('private, no-store');
    expect(list).not.toHaveBeenCalled();

    const conditional = await request(app.getHttpServer())
      .get(`${route}/`)
      .set('Authorization', authorization)
      .set('If-None-Match', '*')
      .set('If-Modified-Since', new Date('2099-01-01').toUTCString());
    expect(conditional.status).toBe(200);
    expect(conditional.headers['cache-control']).toBe('private, no-store');
    expect(list).toHaveBeenCalledExactlyOnceWith({ organizationId, cursor: null, limit: 50 });
  });
});
