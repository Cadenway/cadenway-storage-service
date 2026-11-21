import { createApplication, SkipInternalToken } from '@cadenway/nest-common';
import { Controller, Get, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureSearchProjectionNoStore } from './no-store-search-projections.middleware.js';

const projectionPath = '/internal/v1/attachment-search-projections';

@Controller(projectionPath)
class SearchProjectionFixtureController {
  // #region Methods
  /** Serves a synthetic projection page to exercise Express conditional requests. */
  @Get()
  @SkipInternalToken()
  public list(): { readonly items: readonly []; readonly nextCursor: null } {
    return { items: [], nextCursor: null };
  }

  /** A protected POST to exercise the shared JSON parser. */
  @Post('resolve')
  public resolve(): never {
    throw new Error('The projection parser must reject this request.');
  }
  // #endregion
}

@Module({ controllers: [SearchProjectionFixtureController] })
class SearchProjectionFixtureModule {}

describe('Search projection cache policy', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApplication(SearchProjectionFixtureModule, {
      service: 'storage-service',
      config: { LOG_LEVEL: 'silent' },
      internalToken: {
        verifier: {
          audience: 'storage-service',
          trustedIssuers: {
            'search-service': [
              {
                kty: 'OKP',
                crv: 'Ed25519',
                x: 'MVZQc5h6AXxnMpaBTaYw5kI-yWWawl6zp8Srhuf5NK0',
                kid: 'local-placeholder',
              },
            ],
          },
        },
      },
    });
    configureSearchProjectionNoStore(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('marks guard errors private and no-store', async () => {
    const response = await request(app.getHttpServer())
      .post(`${projectionPath}/resolve/`)
      .send({ fileIds: [] });

    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('marks malformed JSON on the resolve route private and no-store', async () => {
    const response = await request(app.getHttpServer())
      .post(`${projectionPath}/resolve`)
      .set('Content-Type', 'application/json')
      .send('{');

    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('returns the projection page on a conditional GET with the same cache policy', async () => {
    const response = await request(app.getHttpServer())
      .get(`${projectionPath}/?limit=10`)
      .set('If-None-Match', '*');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual({ items: [], nextCursor: null });
  });

  it('leaves unrelated route paths outside the projection cache policy', async () => {
    const response = await request(app.getHttpServer()).get(`${projectionPath}/unrelated`);

    expect(response.headers['cache-control']).toBeUndefined();
  });
});
