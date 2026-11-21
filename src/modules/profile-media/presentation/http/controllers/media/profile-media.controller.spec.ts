import { generateKeyPairSync } from 'node:crypto';

import { createApplication, InternalTokenSigner } from '@cadenway/nest-common';
import type { Ed25519PublicJwk } from '@cadenway/nest-common';
import { Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  noStoreProfileMedia,
  noStoreProfileMediaErrors,
  profileMediaPaths,
} from '../../../../../../infrastructure/http/no-store-profile-media.middleware.js';
import { ProfileMediaError } from '../../../../application/models/media/profile-media-refusal.model.js';
import { PrepareProfileMedia } from '../../../../application/use-cases/commands/media/prepare-profile-media/prepare-profile-media.use-case.js';
import { SignProfileMediaTransfer } from '../../../../application/use-cases/commands/media/sign-profile-media-transfer/sign-profile-media-transfer.use-case.js';
import { ReadProfileMedia } from '../../../../application/use-cases/queries/media/read-profile-media/read-profile-media.use-case.js';
import { ProfileMediaController } from './profile-media.controller.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const userId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30';
const otherUserId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b31';
const uploadId = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01';
const uploadPath = `/internal/v1/profile-media-uploads/${uploadId.toUpperCase()}`;
const avatarPath = `/internal/v1/avatars/${uploadId.toUpperCase()}`;
const logoPath = `/internal/v1/organization/logo-assets/${uploadId.toUpperCase()}`;
const transferBody = {
  kind: 'avatar',
  expiresAt: '2026-11-20T14:30:00Z',
  contentType: 'image/png',
  sizeBytes: 68,
};
const capability = {
  uploadId,
  method: 'POST',
  url: 'https://files.example.test/profile-media',
  fields: { key: 'opaque-test-staging-key' },
  expiresAt: transferBody.expiresAt,
} as const;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGmQAAAAASUVORK5CYII=',
  'base64',
);
const preparation = {
  uploadId,
  contentType: 'image/png',
  sizeBytes: 68,
  width: 256,
  height: 256,
} as const;
const sign = vi.fn<SignProfileMediaTransfer['execute']>();
const prepare = vi.fn<PrepareProfileMedia['execute']>();
const read = vi.fn<ReadProfileMedia['execute']>();
const abortSignal: unknown = expect.any(AbortSignal);

/** Hosts the profile media routes alongside production token and validation middleware. */
@Module({
  controllers: [ProfileMediaController],
  providers: [
    { provide: SignProfileMediaTransfer, useValue: { execute: sign } },
    { provide: PrepareProfileMedia, useValue: { execute: prepare } },
    { provide: ReadProfileMedia, useValue: { execute: read } },
  ],
})
class ProfileMediaRouteModule implements NestModule {
  // #region Methods
  /** Applies the cache policy before the authorization guard. */
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(noStoreProfileMedia).forRoutes(ProfileMediaController);
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

describe('ProfileMediaController', () => {
  let app: NestExpressApplication;
  let accountAuthorization: string;
  let tenantAuthorization: string;
  let systemAuthorization: string;
  let notificationAuthorization: string;

  beforeAll(async () => {
    const [gateway, notification] = await Promise.all([
      signerFor('api-gateway'),
      signerFor('notification-service'),
    ]);
    const account = { type: 'user', id: userId.toUpperCase() } as const;
    const claims = { organizationId: organizationId.toUpperCase(), actor: account };
    const [accountToken, tenantToken, systemToken, notificationToken] = await Promise.all([
      gateway.signer.sign('storage-service', { organizationId: null, actor: account }),
      gateway.signer.sign('storage-service', claims),
      gateway.signer.sign('storage-service', { ...claims, actor: { type: 'system', id: null } }),
      notification.signer.sign('storage-service', claims),
    ]);
    accountAuthorization = `Bearer ${accountToken}`;
    tenantAuthorization = `Bearer ${tenantToken}`;
    systemAuthorization = `Bearer ${systemToken}`;
    notificationAuthorization = `Bearer ${notificationToken}`;
    app = await createApplication(ProfileMediaRouteModule, {
      service: 'storage-service',
      config: { LOG_LEVEL: 'silent' },
      internalToken: {
        verifier: {
          audience: 'storage-service',
          trustedIssuers: {
            'api-gateway': [gateway.publicJwk],
            'notification-service': [notification.publicJwk],
          },
        },
      },
    });
    app.use(profileMediaPaths, noStoreProfileMediaErrors);
    await app.init();
  });

  beforeEach(() => {
    sign.mockReset().mockResolvedValue({ capability });
    prepare.mockReset().mockResolvedValue({ preparation });
    read.mockReset().mockResolvedValue({ png });
  });

  afterAll(async () => {
    await app.close();
  });

  it('signs an account avatar for the verified user with the original deadline', async () => {
    const delivered = { ...capability, objectKey: 'private-key-that-must-not-leave-storage' };
    sign.mockResolvedValue({ capability: delivered });
    const result = await request(app.getHttpServer())
      .post(`${uploadPath}/transfer`)
      .set('Authorization', accountAuthorization)
      .send(transferBody);

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toEqual(capability);
    expect(sign).toHaveBeenCalledExactlyOnceWith({
      owner: { kind: 'avatar', id: userId },
      uploaderUserId: userId,
      uploadId,
      expiresAt: new Date(transferBody.expiresAt),
      contentType: transferBody.contentType,
      sizeBytes: transferBody.sizeBytes,
      signal: abortSignal,
    });
  });

  it('requires account scope for the avatar write and organization scope for the logo write', async () => {
    const scopedAvatar = await request(app.getHttpServer())
      .post(`${uploadPath}/transfer`)
      .set('Authorization', tenantAuthorization)
      .send(transferBody);
    const unscopedLogo = await request(app.getHttpServer())
      .post(`${uploadPath}/preparation`)
      .set('Authorization', accountAuthorization)
      .send({ kind: 'organization-logo' });

    expect(scopedAvatar.status).toBe(404);
    expect(scopedAvatar.body).toMatchObject({ code: 'media.not-found' });
    expect(unscopedLogo.status).toBe(403);
    expect(unscopedLogo.body).toMatchObject({ code: 'auth.organization-required' });
    expect(sign).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('prepares the organization logo for its verified uploader and returns only elected metadata', async () => {
    const elected = { ...preparation, candidateId: 'private-candidate' };
    prepare.mockResolvedValue({ preparation: elected });
    const result = await request(app.getHttpServer())
      .post(`${uploadPath}/preparation`)
      .set('Authorization', tenantAuthorization)
      .set('X-Organization-Id', otherUserId)
      .send({ kind: 'organization-logo' });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toEqual(preparation);
    expect(prepare).toHaveBeenCalledExactlyOnceWith({
      owner: { kind: 'organization-logo', id: organizationId },
      uploaderUserId: userId,
      uploadId,
      signal: abortSignal,
    });
  });

  it('returns PNG bytes with private headers on every authorized read despite conditional headers', async () => {
    const addresses = [
      [`${avatarPath}?ownerUserId=${userId.toUpperCase()}`, accountAuthorization, 'avatar', userId],
      [`${avatarPath}?ownerUserId=${otherUserId}`, tenantAuthorization, 'avatar', otherUserId],
      [logoPath, tenantAuthorization, 'organization-logo', organizationId],
    ] as const;
    for (const [address, authorization, kind, ownerId] of addresses) {
      const result = await request(app.getHttpServer())
        .get(address)
        .set('Authorization', authorization)
        .set('If-None-Match', '*')
        .set('If-Modified-Since', 'Tue, 19 Jan 2038 03:14:07 GMT');
      expect(result.status).toBe(200);
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.headers['content-type']).toBe('image/png');
      expect(result.headers['content-length']).toBe(String(png.byteLength));
      expect(result.headers['x-content-type-options']).toBe('nosniff');
      expect(result.headers.etag).toBeUndefined();
      expect(result.body).toEqual(png);
      expect(read).toHaveBeenLastCalledWith({
        owner: { kind, id: ownerId },
        assetId: uploadId,
        signal: abortSignal,
      });
    }
  });

  it('refuses a cross-account directory read without its tenant and non-gateway or non-user tokens', async () => {
    const calls = [
      [
        `${avatarPath}?ownerUserId=${otherUserId}`,
        accountAuthorization,
        403,
        'auth.organization-required',
      ],
      [logoPath, accountAuthorization, 403, 'auth.organization-required'],
      [logoPath, systemAuthorization, 403, 'auth.actor-not-allowed'],
      [logoPath, notificationAuthorization, 403, 'auth.issuer-not-allowed'],
      [logoPath, '', 401, 'auth.token-missing'],
    ] as const;
    for (const [address, authorization, status, code] of calls) {
      const call = request(app.getHttpServer()).get(address);
      if (authorization !== '') call.set('Authorization', authorization);
      const result = await call;
      expect(result.status).toBe(status);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).toMatchObject({ code });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('separates malformed transfer declarations from understandable policy refusals', async () => {
    const bodies = [
      [{ sizeBytes: 5242881 }, 422, 'media.file-too-large'],
      [{ contentType: 'image/gif' }, 422, 'media.unsupported-type'],
      [{ sizeBytes: '1' }, 400, 'request.invalid'],
      [{ uploaderUserId: otherUserId }, 400, 'request.invalid'],
    ] as const;
    for (const [changes, status, code] of bodies) {
      const result = await request(app.getHttpServer())
        .post(`${uploadPath}/transfer`)
        .set('Authorization', accountAuthorization)
        .send({ ...transferBody, ...changes });
      expect(result.status).toBe(status);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).toMatchObject({ code });
    }
    expect(sign).not.toHaveBeenCalled();
  });

  it('keeps malformed JSON uncached and omits its raw content from the problem', async () => {
    const result = await request(app.getHttpServer())
      .post(`${uploadPath}/transfer`)
      .set('Authorization', accountAuthorization)
      .set('Content-Type', 'application/json')
      .send('{"draftKey":"private-body-fixture"');

    expect(result.status).toBe(400);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toMatchObject({ code: 'request.invalid' });
    expect(result.text).not.toContain('private-body-fixture');
    expect(sign).not.toHaveBeenCalled();
  });

  it('maps an equivalent signing conflict and withholds oversized or hidden derivatives', async () => {
    sign.mockRejectedValue(new ProfileMediaError('request-in-progress'));
    read.mockResolvedValueOnce({ png: Buffer.alloc(5242881) });
    read.mockRejectedValueOnce(new ProfileMediaError('not-found'));
    const concurrent = await request(app.getHttpServer())
      .post(`${uploadPath}/transfer`)
      .set('Authorization', accountAuthorization)
      .send(transferBody);
    const oversized = await request(app.getHttpServer())
      .get(logoPath)
      .set('Authorization', tenantAuthorization);
    const hidden = await request(app.getHttpServer())
      .get(logoPath)
      .set('Authorization', tenantAuthorization);

    expect(concurrent.status).toBe(409);
    expect(concurrent.body).toMatchObject({ code: 'idempotency.request-in-progress' });
    expect(oversized.status).toBe(503);
    expect(oversized.body).toMatchObject({ code: 'storage.unavailable' });
    expect(hidden.status).toBe(404);
    expect(hidden.body).toMatchObject({ code: 'media.not-found' });
    expect(concurrent.headers['cache-control']).toBe('no-store');
    expect(oversized.headers['cache-control']).toBe('no-store');
    expect(hidden.headers['cache-control']).toBe('no-store');
  });
});
