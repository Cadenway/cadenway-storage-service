import { generateKeyPairSync } from 'node:crypto';

import { createApplication, InternalTokenSigner } from '@cadenway/nest-common';
import type { Ed25519PublicJwk } from '@cadenway/nest-common';
import { Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  noStoreIntakeAttachmentParserErrors,
  noStoreIntakeAttachments,
} from '../../../../../../infrastructure/http/no-store-intake-attachments.middleware.js';
import { AttachmentRefusal } from '../../../../application/models/attachment/attachment-refusal.model.js';
import { CompleteIntakeAttachmentUpload } from '../../../../application/use-cases/commands/intake-attachment/complete-intake-attachment-upload/complete-intake-attachment-upload.use-case.js';
import { StartIntakeAttachmentUpload } from '../../../../application/use-cases/commands/intake-attachment/start-intake-attachment-upload/start-intake-attachment-upload.use-case.js';
import { IntakeAttachmentsController } from './intake-attachments.controller.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const publicationId = '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f12';
const attachmentId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
const route = `/internal/v1/intake-publications/${publicationId.toUpperCase()}/attachments`;
const body = {
  attachmentId: attachmentId.toUpperCase(),
  expiresAt: '2026-11-20T14:30:00Z',
  fileName: 'fixture.png',
  contentType: 'image/png',
  sizeBytes: 184320,
};
const capability = {
  id: attachmentId,
  method: 'POST',
  url: 'https://files.example.test/intake-upload',
  fields: { key: 'intake/019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f16' },
  expiresAt: '2026-11-20T14:05:00Z',
} as const;
const start = vi.fn<StartIntakeAttachmentUpload['execute']>();
const complete = vi.fn<CompleteIntakeAttachmentUpload['execute']>();

/** Hosts the intake routes with the same guard, validation and middleware as production. */
@Module({
  controllers: [IntakeAttachmentsController],
  providers: [
    { provide: StartIntakeAttachmentUpload, useValue: { execute: start } },
    { provide: CompleteIntakeAttachmentUpload, useValue: { execute: complete } },
  ],
})
class IntakeAttachmentRouteModule implements NestModule {
  // #region Methods
  /** Installs caching protection before guards and validation. */
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(noStoreIntakeAttachments).forRoutes(IntakeAttachmentsController);
  }
  // #endregion
}

async function signerFor(
  issuer: string,
): Promise<{ readonly signer: InternalTokenSigner; readonly publicJwk: Ed25519PublicJwk }> {
  const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  if (x === undefined || d === undefined) throw new Error('The test key could not be generated.');
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', kid: issuer, x };
  const signer = await InternalTokenSigner.create({ issuer, privateJwk: { ...publicJwk, d } });
  return { signer, publicJwk };
}

describe('IntakeAttachmentsController', () => {
  let app: NestExpressApplication;
  let authorization: string;
  let userAuthorization: string;
  let unscopedAuthorization: string;
  let taskAuthorization: string;

  beforeAll(async () => {
    const [gateway, task] = await Promise.all([
      signerFor('api-gateway'),
      signerFor('task-service'),
    ]);
    const claims = { organizationId, actor: { type: 'system', id: null } } as const;
    const [gatewayToken, userToken, unscopedToken, taskToken] = await Promise.all([
      gateway.signer.sign('storage-service', claims),
      gateway.signer.sign('storage-service', {
        organizationId,
        actor: { type: 'user', id: attachmentId },
      }),
      gateway.signer.sign('storage-service', { ...claims, organizationId: null }),
      task.signer.sign('storage-service', claims),
    ]);
    authorization = `Bearer ${gatewayToken}`;
    userAuthorization = `Bearer ${userToken}`;
    unscopedAuthorization = `Bearer ${unscopedToken}`;
    taskAuthorization = `Bearer ${taskToken}`;
    app = await createApplication(IntakeAttachmentRouteModule, {
      service: 'storage-service',
      config: { LOG_LEVEL: 'silent' },
      internalToken: {
        verifier: {
          audience: 'storage-service',
          trustedIssuers: { 'api-gateway': [gateway.publicJwk], 'task-service': [task.publicJwk] },
        },
      },
    });
    app.use('/internal/v1/intake-publications', noStoreIntakeAttachmentParserErrors);
    await app.init();
  });

  beforeEach(() => {
    start.mockReset().mockResolvedValue({ capability, replayed: true });
    complete.mockReset().mockResolvedValue({ id: attachmentId });
  });

  afterAll(async () => {
    await app.close();
  });

  it('signs the canonical Task allocation in the tenant taken from the service token', async () => {
    const result = await request(app.getHttpServer())
      .post(route)
      .set('Authorization', authorization)
      .send(body);

    expect(result.status).toBe(201);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers.location).toBe(
      `/internal/v1/intake-publications/${publicationId}/attachments/${attachmentId}`,
    );
    expect(result.body).toEqual(capability);
    expect(start).toHaveBeenCalledExactlyOnceWith({
      ...body,
      organizationId,
      publicationId,
      attachmentId,
      expiresAt: new Date(body.expiresAt),
    });
  });

  it('acknowledges verification without forwarding internal result fields', async () => {
    const internal = { id: attachmentId, candidateKey: 'private-candidate' };
    complete.mockResolvedValue(internal);
    const result = await request(app.getHttpServer())
      .post(`${route}/${attachmentId.toUpperCase()}/completion`)
      .set('Authorization', authorization);

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toEqual({ id: attachmentId });
    expect(complete).toHaveBeenCalledExactlyOnceWith({
      organizationId,
      publicationId,
      attachmentId,
    });
  });

  it('refuses missing credentials and signed claims with the wrong actor, tenant or issuer', async () => {
    const refused = [
      ['', 401, 'auth.token-missing'],
      [userAuthorization, 403, 'auth.actor-not-allowed'],
      [unscopedAuthorization, 403, 'auth.organization-required'],
      [taskAuthorization, 403, 'auth.issuer-not-allowed'],
    ] as const;
    for (const [token, status, code] of refused) {
      const call = request(app.getHttpServer()).post(route);
      if (token !== '') call.set('Authorization', token);
      const result = await call.send(body);
      expect(result.status).toBe(status);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).toMatchObject({ status, code });
    }
    expect(start).not.toHaveBeenCalled();
  });

  it('answers parser and contract validation failures with no-store and no applicant data', async () => {
    const malformed = await request(app.getHttpServer())
      .post(route)
      .set('Authorization', authorization)
      .set('Content-Type', 'application/json')
      .send('{"draftKey":"fixture-body-content"');
    const extraField = await request(app.getHttpServer())
      .post(route)
      .set('Authorization', authorization)
      .send({ ...body, organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b00' });
    for (const invalid of [malformed, extraField]) {
      expect(invalid.status).toBe(400);
      expect(invalid.headers['cache-control']).toBe('no-store');
      expect(invalid.body).toMatchObject({ code: 'request.invalid' });
    }
    expect(malformed.text).not.toContain('fixture-body-content');
    expect(start).not.toHaveBeenCalled();
  });

  it('hides rejected reservations and errors reading durable state', async () => {
    const address = `${route}/${attachmentId}/completion`;
    complete.mockRejectedValueOnce(new AttachmentRefusal('not-found'));
    complete.mockRejectedValueOnce(
      new Error('while reading a private candidate', {
        cause: Object.assign(new Error('fixture-private-metadata'), { code: '08006' }),
      }),
    );
    const missing = await request(app.getHttpServer())
      .post(address)
      .set('Authorization', authorization);
    const unavailable = await request(app.getHttpServer())
      .post(address)
      .set('Authorization', authorization);

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'attachment.not-found' });
    expect(missing.headers['cache-control']).toBe('no-store');
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ code: 'storage.unavailable' });
    expect(unavailable.headers['cache-control']).toBe('no-store');
    expect(unavailable.text).not.toContain('fixture-private-metadata');
  });
});
