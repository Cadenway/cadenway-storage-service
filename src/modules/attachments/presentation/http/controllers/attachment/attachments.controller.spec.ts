import { createHash } from 'node:crypto';

import {
  ProblemFilter,
  runWithOrganizationContext,
  ZodValidationPipe,
} from '@cadenway/nest-common';
import type { OrganizationContext } from '@cadenway/nest-common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request } from 'express';
import type { Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { AttachmentRefusal } from '../../../../application/models/attachment/attachment-refusal.model.js';
import { AttachmentObjectStorageError } from '../../../../application/models/attachment/attachment-object-storage-error.model.js';
import type { CompleteAttachmentUpload } from '../../../../application/use-cases/commands/attachment/complete-attachment-upload/complete-attachment-upload.use-case.js';
import { CompleteAttachmentUpload as CompleteUploadProvider } from '../../../../application/use-cases/commands/attachment/complete-attachment-upload/complete-attachment-upload.use-case.js';
import type { DeleteAttachment } from '../../../../application/use-cases/commands/attachment/delete-attachment/delete-attachment.use-case.js';
import { DeleteAttachment as DeleteAttachmentProvider } from '../../../../application/use-cases/commands/attachment/delete-attachment/delete-attachment.use-case.js';
import type { StartAttachmentUpload } from '../../../../application/use-cases/commands/attachment/start-attachment-upload/start-attachment-upload.use-case.js';
import { StartAttachmentUpload as StartUploadProvider } from '../../../../application/use-cases/commands/attachment/start-attachment-upload/start-attachment-upload.use-case.js';
import type { GetAttachmentDownload } from '../../../../application/use-cases/queries/attachment/get-attachment-download/get-attachment-download.use-case.js';
import { GetAttachmentDownload as DownloadProvider } from '../../../../application/use-cases/queries/attachment/get-attachment-download/get-attachment-download.use-case.js';
import type { GetAttachment } from '../../../../application/use-cases/queries/attachment/get-attachment/get-attachment.use-case.js';
import { GetAttachment as GetAttachmentProvider } from '../../../../application/use-cases/queries/attachment/get-attachment/get-attachment.use-case.js';
import type { ListAttachments } from '../../../../application/use-cases/queries/attachment/list-attachments/list-attachments.use-case.js';
import { ListAttachments as ListAttachmentsProvider } from '../../../../application/use-cases/queries/attachment/list-attachments/list-attachments.use-case.js';
import type { ListLargestAttachments } from '../../../../application/use-cases/queries/attachment/list-largest-attachments/list-largest-attachments.use-case.js';
import { ListLargestAttachments as LargestProvider } from '../../../../application/use-cases/queries/attachment/list-largest-attachments/list-largest-attachments.use-case.js';
import { AttachmentsController } from './attachments.controller.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const actorId = '019a5f3c-9e1f-7b2a-8c3d-4e5f6a7b8c31';
const attachmentId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
const context: OrganizationContext = {
  organizationId,
  actor: { type: 'user', id: actorId },
  role: null,
  scopes: [],
};
const path = { taskKey: 'CAD-482', attachmentId };
const metadata = {
  id: attachmentId,
  taskKey: path.taskKey,
  fileName: 'maquette-sso.png',
  contentType: 'image/png',
  sizeBytes: 248320,
  authorUserId: actorId,
  uploadedAt: '2026-11-08T08:05:00.000Z',
  version: 1,
};
const capability = {
  id: attachmentId,
  method: 'POST',
  url: 'https://files.example.test/upload',
  fields: { key: 'fixture' },
  expiresAt: '2026-11-08T08:10:00.000Z',
};

function fixture(): {
  readonly controller: AttachmentsController;
  readonly operations: Record<
    'list' | 'start' | 'get' | 'delete' | 'complete' | 'download' | 'largest',
    ReturnType<typeof vi.fn>
  >;
  readonly headers: ReturnType<typeof vi.fn>;
  readonly response: Response;
} {
  const operations = {
    list: vi.fn().mockResolvedValue({ items: [metadata], nextCursor: null }),
    start: vi.fn().mockResolvedValue({ capability, replayed: false }),
    get: vi.fn().mockResolvedValue(metadata),
    delete: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue({ attachment: metadata }),
    download: vi.fn().mockResolvedValue({
      url: 'https://files.example.test/download',
      expiresAt: capability.expiresAt,
    }),
    largest: vi.fn().mockResolvedValue({ items: [metadata], nextCursor: null }),
  };
  const headers = vi.fn();
  return {
    controller: new AttachmentsController(
      { execute: operations.list } as unknown as ListAttachments,
      { execute: operations.start } as unknown as StartAttachmentUpload,
      { execute: operations.get } as unknown as GetAttachment,
      { execute: operations.delete } as unknown as DeleteAttachment,
      { execute: operations.complete } as unknown as CompleteAttachmentUpload,
      { execute: operations.download } as unknown as GetAttachmentDownload,
      { execute: operations.largest } as unknown as ListLargestAttachments,
    ),
    operations,
    headers,
    response: { setHeader: headers } as unknown as Response,
  };
}

describe('AttachmentsController', () => {
  it('passes the verified tenant and cursor to both listing operations', async () => {
    const { controller, operations } = fixture();
    await runWithOrganizationContext(context, async () => {
      await controller.list({ taskKey: path.taskKey }, { limit: 25, cursor: 'opaque' });
      await controller.largest({ limit: 50 });
    });
    expect(operations.list).toHaveBeenCalledWith({
      organizationId,
      taskKey: path.taskKey,
      cursor: 'opaque',
      limit: 25,
    });
    expect(operations.largest).toHaveBeenCalledWith({ organizationId, cursor: null, limit: 50 });
  });

  it('returns the original reservation with no-store and its stable Location', async () => {
    const { controller, operations, headers, response } = fixture();
    const body = {
      fileName: metadata.fileName,
      contentType: metadata.contentType,
      sizeBytes: metadata.sizeBytes,
    };
    const result = await runWithOrganizationContext(context, () =>
      controller.start({ taskKey: path.taskKey }, body, 'request-1', response),
    );
    expect(result).toEqual(capability);
    expect(operations.start).toHaveBeenCalledWith(
      expect.objectContaining({
        ...body,
        organizationId,
        actorId,
        taskKey: path.taskKey,
        idempotencyKey: 'request-1',
        fingerprint: createHash('sha256')
          .update(JSON.stringify([body.fileName, body.contentType, body.sizeBytes]))
          .digest('hex'),
      }),
    );
    expect(headers).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(headers).toHaveBeenCalledWith(
      'Location',
      `/internal/v1/tasks/CAD-482/attachments/${attachmentId}`,
    );
  });

  it('sets entity tags on metadata and completion and passes a conditional deletion', async () => {
    const { controller, operations, headers, response } = fixture();
    await runWithOrganizationContext(context, async () => {
      expect(await controller.get(path, response)).toEqual(metadata);
      expect(await controller.complete(path, response)).toEqual(metadata);
      await controller.delete(path, '"1"');
    });
    expect(headers).toHaveBeenCalledWith('ETag', '"1"');
    expect(operations.complete).toHaveBeenCalledWith({ ...path, organizationId, actorId });
    expect(operations.delete).toHaveBeenCalledWith({
      ...path,
      organizationId,
      actorId,
      expectedVersion: 1,
    });
  });

  it('marks signed downloads no-store and maps hidden attachment refusals', async () => {
    const { controller, operations, headers, response } = fixture();
    await runWithOrganizationContext(context, async () => {
      await controller.download(path, response);
      operations.download.mockRejectedValueOnce(new AttachmentRefusal('not-found'));
      await expect(controller.download(path, response)).rejects.toMatchObject({
        status: 404,
        response: { code: 'attachment.not-found' },
      });
    });
    expect(headers).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('rejects an invalid conditional header before invoking the operation', async () => {
    const { controller, operations } = fixture();
    await runWithOrganizationContext(context, async () => {
      await expect(controller.delete(path, 'W/"1"')).rejects.toMatchObject({ status: 400 });
    });
    expect(operations.delete).not.toHaveBeenCalled();
  });

  it('returns the stable unavailable problem for object storage failures', async () => {
    const { controller, operations, response } = fixture();
    operations.download.mockRejectedValueOnce(new AttachmentObjectStorageError());
    await runWithOrganizationContext(context, async () => {
      await expect(controller.download(path, response)).rejects.toMatchObject({
        status: 503,
        response: { code: 'storage.unavailable' },
      });
    });
  });
});

describe('attachment HTTP validation', () => {
  it('uses the generated DTOs and rejects unknown input through the global validation pipe', async () => {
    const { operations } = fixture();
    const module = await Test.createTestingModule({
      controllers: [AttachmentsController],
      providers: [
        { provide: ListAttachmentsProvider, useValue: { execute: operations.list } },
        { provide: StartUploadProvider, useValue: { execute: operations.start } },
        { provide: GetAttachmentProvider, useValue: { execute: operations.get } },
        { provide: DeleteAttachmentProvider, useValue: { execute: operations.delete } },
        { provide: CompleteUploadProvider, useValue: { execute: operations.complete } },
        { provide: DownloadProvider, useValue: { execute: operations.download } },
        { provide: LargestProvider, useValue: { execute: operations.largest } },
      ],
    }).compile();
    const app: NestExpressApplication = module.createNestApplication<NestExpressApplication>();
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      runWithOrganizationContext(context, next);
    });
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalFilters(new ProblemFilter());
    await app.init();
    try {
      const route = '/internal/v1/tasks/CAD-482/attachments';
      const body = {
        fileName: metadata.fileName,
        contentType: metadata.contentType,
        sizeBytes: metadata.sizeBytes,
      };
      const accepted = await request(app.getHttpServer())
        .post(route)
        .set('Idempotency-Key', 'request-1')
        .send(body);
      expect(accepted.status).toBe(201);
      expect(accepted.headers['cache-control']).toBe('no-store');
      expect(accepted.headers.location).toBe(`${route}/${attachmentId}`);
      const invalidBody = await request(app.getHttpServer())
        .post(route)
        .send({ ...body, actorId });
      expect(invalidBody.status).toBe(400);
      expect(invalidBody.body).toMatchObject({ code: 'request.invalid' });
      const invalidQuery = await request(app.getHttpServer()).get(`${route}?limit=5&unknown=1`);
      expect(invalidQuery.status).toBe(400);
      expect(invalidQuery.body).toMatchObject({ code: 'request.invalid' });
      const list = await request(app.getHttpServer()).get(`${route}?limit=5`);
      expect(list.status).toBe(200);
      expect(list.body).toEqual({ items: [metadata], nextCursor: null });
      const largest = await request(app.getHttpServer()).get('/internal/v1/attachments/largest');
      expect(largest.status).toBe(200);
      const detail = await request(app.getHttpServer()).get(`${route}/${attachmentId}`);
      expect(detail.status).toBe(200);
      expect(detail.headers.etag).toBe('"1"');
      const complete = await request(app.getHttpServer()).post(
        `${route}/${attachmentId}/completion`,
      );
      expect(complete.status).toBe(200);
      expect(complete.headers.etag).toBe('"1"');
      const download = await request(app.getHttpServer()).get(`${route}/${attachmentId}/download`);
      expect(download.status).toBe(200);
      expect(download.headers['cache-control']).toBe('no-store');
      const badTag = await request(app.getHttpServer())
        .delete(`${route}/${attachmentId}`)
        .set('If-Match', 'W/"1"');
      expect(badTag.status).toBe(400);
      expect(operations.delete).not.toHaveBeenCalled();
      const deleted = await request(app.getHttpServer())
        .delete(`${route}/${attachmentId}`)
        .set('If-Match', '"1"');
      expect(deleted.status).toBe(204);
      expect(deleted.text).toBe('');
    } finally {
      await app.close();
    }
  });
});
