import type { S3Client } from '@aws-sdk/client-s3';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import { isTracingSuppressed } from '@opentelemetry/core';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachmentObjectStorageError } from '../../../application/ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import { S3AttachmentObjectStore } from './s3-attachment-object-store.adapter.js';

const ORGANIZATION = '11111111-2222-4333-8444-555555555555';
const ATTACHMENT = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01';
const STAGING = `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b02`;
const CANDIDATE = `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b03`;
const INTAKE_STAGING = 'intake/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b04';
const FOREIGN_ORGANIZATION = '91111111-2222-4333-8444-555555555555';
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/VZkAAAAASUVORK5CYII=',
  'base64',
);
const ICO_HEADER = Buffer.alloc(22);
ICO_HEADER.writeUInt16LE(1, 2); // Icon format.
ICO_HEADER.writeUInt16LE(1, 4); // One image.
ICO_HEADER.writeUInt8(1, 6); // Width and height of the embedded PNG.
ICO_HEADER.writeUInt8(1, 7);
ICO_HEADER.writeUInt16LE(1, 10); // One color plane.
ICO_HEADER.writeUInt16LE(32, 12);
ICO_HEADER.writeUInt32LE(PNG.length, 14);
ICO_HEADER.writeUInt32LE(ICO_HEADER.length, 18);
const ICO = Buffer.concat([ICO_HEADER, PNG]);
const UTF8_SPLIT_PREFIX = Buffer.concat([Buffer.alloc(4_094, 0x61), Buffer.from([0xe2, 0x82])]);

type Handler = S3Client['config']['requestHandler'];
const stores: S3AttachmentObjectStore[] = [];

function fixture(eraseTransientVersions = false): {
  readonly handle: ReturnType<typeof vi.fn<Handler['handle']>>;
  readonly store: S3AttachmentObjectStore;
} {
  const handle = vi.fn<Handler['handle']>();
  const store = new S3AttachmentObjectStore(
    'attachment-test',
    {
      credentials: { accessKeyId: 'unit-fixture', secretAccessKey: 'not-a-real-credential' },
      region: 'garage',
      endpoint: 'https://store.internal.example.test',
      forcePathStyle: true,
      requestHandler: { handle, destroy: vi.fn() },
    },
    'https://files.example.test',
    eraseTransientVersions,
  );
  stores.push(store);
  return { handle, store };
}

function response(
  statusCode: number,
  headers: Record<string, string> = {},
  body: Buffer | Readable = Buffer.alloc(0),
): Awaited<ReturnType<Handler['handle']>> {
  return { response: { statusCode, headers, body } };
}

function head(
  size: number,
  mediaType: string,
  version: string,
): Awaited<ReturnType<Handler['handle']>> {
  return response(200, {
    'content-length': String(size),
    'content-type': mediaType,
    etag: `"${version}"`,
  });
}

function copied(version: string): Awaited<ReturnType<Handler['handle']>> {
  const body = Buffer.from(
    `<CopyObjectResult><ETag>&quot;${version}&quot;</ETag></CopyObjectResult>`,
  );
  return response(200, {}, body);
}

function partial(bytes: Buffer, size: number): Awaited<ReturnType<Handler['handle']>> {
  return response(
    206,
    {
      'content-length': String(bytes.length),
      'content-range': `bytes 0-${String(bytes.length - 1)}/${String(size)}`,
    },
    Readable.from([bytes]),
  );
}

afterEach(() => {
  for (const store of stores.splice(0)) store.onModuleDestroy();
  vi.useRealTimers();
});

describe('S3AttachmentObjectStore', () => {
  it('lists only the attachment prefix and suppresses HTTP tracing only for that request', async () => {
    const { handle, store } = fixture();
    const contexts = new AsyncLocalStorage<Context>();
    const recordedSuppression: boolean[] = [];
    const manager = {
      active: () => contexts.getStore() ?? ROOT_CONTEXT,
      with: <Args extends unknown[], Result>(
        active: Context,
        callback: (...args: Args) => Result,
        thisArg?: unknown,
        ...args: Args
      ): Result => contexts.run(active, () => callback.apply(thisArg, args)),
      bind: <Target>(_active: Context, target: Target): Target => target,
      enable: () => manager,
      disable: () => {
        contexts.disable();
        return manager;
      },
    };
    expect(context.setGlobalContextManager(manager)).toBe(true);
    handle.mockImplementation(() => {
      const suppressed = isTracingSuppressed(context.active());
      recordedSuppression.push(suppressed);
      if (!suppressed) return Promise.resolve(response(204));
      return Promise.resolve(
        response(
          200,
          {},
          Buffer.from(
            `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>opaque-next</NextContinuationToken><Contents><Key>${CANDIDATE}</Key></Contents><Contents><Key>org/unknown/path</Key></Contents></ListBucketResult>`,
          ),
        ),
      );
    });

    try {
      await expect(
        store.listAttachmentObjects('opaque-previous', new AbortController().signal),
      ).resolves.toEqual({
        objects: [{ organizationId: ORGANIZATION, objectKey: CANDIDATE }],
        next: 'opaque-next',
      });
      const request: unknown = handle.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        query: {
          prefix: 'org/',
          'list-type': '2',
          'max-keys': '500',
          'continuation-token': 'opaque-previous',
        },
      });
      await expect(store.deleteObject(CANDIDATE, 'preserve')).resolves.toBeUndefined();
      expect(recordedSuppression).toEqual([true, false]);
    } finally {
      context.disable();
    }
  });

  it('rejects a truncated inventory page when the storage cursor cannot advance', async () => {
    const { handle, store } = fixture();
    handle.mockResolvedValue(
      response(
        200,
        {},
        Buffer.from(
          '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>same-page</NextContinuationToken></ListBucketResult>',
        ),
      ),
    );
    await expect(
      store.listAttachmentObjects('same-page', new AbortController().signal),
    ).rejects.toBeInstanceOf(AttachmentObjectStorageError);
  });

  it('pages only canonical intake staging keys without deriving a tenant from them', async () => {
    const { handle, store } = fixture();
    handle.mockResolvedValue(
      response(
        200,
        {},
        Buffer.from(
          `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next-intake</NextContinuationToken><Contents><Key>${INTAKE_STAGING}</Key></Contents><Contents><Key>${CANDIDATE}</Key></Contents><Contents><Key>${INTAKE_STAGING}/extra</Key></Contents></ListBucketResult>`,
        ),
      ),
    );

    await expect(
      store.listIntakeObjects('previous-intake', new AbortController().signal),
    ).resolves.toEqual({
      objects: [{ objectKey: INTAKE_STAGING }],
      next: 'next-intake',
    });
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      query: {
        prefix: 'intake/',
        'list-type': '2',
        'max-keys': '500',
        'continuation-token': 'previous-intake',
      },
    });
  });

  it('switches inventory modes and carries the complete bounded S3 version cursor', async () => {
    const { handle, store } = fixture(true);
    const signal = new AbortController().signal;
    handle.mockResolvedValueOnce(
      response(
        200,
        {},
        Buffer.from(
          `<ListVersionsResult><IsTruncated>true</IsTruncated>
            <NextKeyMarker>${STAGING}</NextKeyMarker><NextVersionIdMarker>generation-1</NextVersionIdMarker>
            <DeleteMarker><Key>${STAGING}</Key><IsLatest>true</IsLatest></DeleteMarker>
            <Version><Key>${STAGING}</Key><IsLatest>false</IsLatest></Version>
            <Version><Key>${CANDIDATE}</Key><IsLatest>true</IsLatest></Version>
            </ListVersionsResult>`,
        ),
      ),
    );
    handle.mockResolvedValueOnce(
      response(
        200,
        {},
        Buffer.from('<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>'),
      ),
    );

    const page = await store.listAttachmentObjects('old-opaque-cursor', signal);
    expect(page.objects).toEqual([
      { organizationId: ORGANIZATION, objectKey: STAGING, transientOnly: true },
      { organizationId: ORGANIZATION, objectKey: CANDIDATE },
    ]);
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      query: { prefix: 'org/', versions: '', 'max-keys': '500' },
    });
    expect(page.next).not.toBeNull();
    await expect(store.listAttachmentObjects(page.next, signal)).resolves.toEqual({
      objects: [],
      next: null,
    });
    expect(handle.mock.calls[1]?.[0]).toMatchObject({
      query: { 'key-marker': STAGING, 'version-id-marker': 'generation-1' },
    });
  });

  it('signs the public origin, exact key, media type and size range into a short POST policy', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-20T14:00:00.450Z') });
    const { handle, store } = fixture();
    const grant = await store.signUpload({
      attachmentId: ATTACHMENT,
      stagingKey: STAGING,
      contentType: 'image/png',
      sizeBytes: PNG.length,
      expiresAt: new Date(Date.now() + 300_000),
    });

    expect(grant).toMatchObject({
      id: ATTACHMENT,
      method: 'POST',
      url: 'https://files.example.test/attachment-test',
      expiresAt: '2026-11-20T14:05:00.000Z',
      fields: { key: STAGING, 'Content-Type': 'image/png' },
    });
    const policy: unknown = JSON.parse(Buffer.from(grant.fields.Policy ?? '', 'base64').toString());
    const conditions: unknown = expect.arrayContaining([
      ['content-length-range', 1, PNG.length],
      { bucket: 'attachment-test' },
      { key: STAGING },
      { 'Content-Type': 'image/png' },
    ]);
    expect(policy).toEqual({
      expiration: '2026-11-20T14:05:00Z',
      conditions,
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects signing after the reservation cannot yield a live policy', async () => {
    const { handle, store } = fixture();
    await expect(
      store.signUpload({
        attachmentId: ATTACHMENT,
        stagingKey: STAGING,
        contentType: 'image/png',
        sizeBytes: PNG.length,
        expiresAt: new Date(Date.now() - 1),
      }),
    ).rejects.toBeInstanceOf(AttachmentObjectStorageError);
    expect(handle).not.toHaveBeenCalled();
  });

  it('signs only the opaque intake key up to the draft expiry', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-20T14:00:00.450Z') });
    const { handle, store } = fixture();
    const input = {
      organizationId: ORGANIZATION,
      attachmentId: ATTACHMENT,
      stagingKey: INTAKE_STAGING,
      contentType: 'image/png',
      sizeBytes: PNG.length,
      expiresAt: new Date('2026-11-20T14:00:46.000Z'),
    };
    const grant = await store.signIntakeUpload(input);
    expect(grant).toMatchObject({
      expiresAt: '2026-11-20T14:00:45.000Z',
      fields: { key: INTAKE_STAGING, 'Content-Type': 'image/png' },
    });
    const policy: unknown = JSON.parse(Buffer.from(grant.fields.Policy ?? '', 'base64').toString());
    const conditions: unknown = expect.arrayContaining([['content-length-range', 1, PNG.length]]);
    expect(policy).toMatchObject({
      conditions,
    });
    await expect(store.signUpload(input)).rejects.toBeInstanceOf(AttachmentObjectStorageError);
    await expect(store.signIntakeUpload({ ...input, stagingKey: STAGING })).rejects.toBeInstanceOf(
      AttachmentObjectStorageError,
    );
    await expect(
      store.signIntakeUpload({ ...input, organizationId: 'invalid-organization' }),
    ).rejects.toBeInstanceOf(AttachmentObjectStorageError);
    expect(handle).not.toHaveBeenCalled();
  });

  it('pins the staged copy and checks the immutable candidate through a conditional 4 KiB range', async () => {
    const { handle, store } = fixture();
    const prefix = Buffer.alloc(4_096);
    PNG.copy(prefix);
    handle
      .mockResolvedValueOnce(head(8_192, 'image/png', 'source'))
      .mockResolvedValueOnce(copied('candidate'))
      .mockResolvedValueOnce(head(8_192, 'image/png', 'candidate'))
      .mockResolvedValueOnce(partial(prefix, 8_192));

    await expect(
      store.copyAndVerify({ stagingKey: STAGING, candidateKey: CANDIDATE, sizeBytes: 8_192 }),
    ).resolves.toEqual({
      sizeBytes: 8_192,
      contentType: 'image/png',
      verifiedContentType: 'image/png',
    });
    expect(handle).toHaveBeenCalledTimes(4);
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      hostname: 'store.internal.example.test',
      method: 'HEAD',
      path: `/attachment-test/${STAGING}`,
    });
    expect(handle.mock.calls[1]?.[0]).toMatchObject({
      method: 'PUT',
      path: `/attachment-test/${CANDIDATE}`,
      headers: {
        'x-amz-copy-source': `attachment-test/${STAGING}`,
        'x-amz-copy-source-if-match': '"source"',
      },
    });
    expect(handle.mock.calls[2]?.[0]).toMatchObject({
      method: 'HEAD',
      path: `/attachment-test/${CANDIDATE}`,
    });
    expect(handle.mock.calls[3]?.[0]).toMatchObject({
      method: 'GET',
      path: `/attachment-test/${CANDIDATE}`,
      headers: { range: 'bytes=0-4095', 'if-match': '"candidate"' },
    });
  });

  it('keeps unknown bytes unverified even if the stored content type names an allowed binary', async () => {
    const { handle, store } = fixture();
    const text = Buffer.from('Unverified, text-only fixture.');
    handle
      .mockResolvedValueOnce(head(text.length, 'image/png', 'source'))
      .mockResolvedValueOnce(copied('candidate'))
      .mockResolvedValueOnce(head(text.length, 'image/png', 'candidate'))
      .mockResolvedValueOnce(partial(text, text.length));

    await expect(
      store.copyAndVerify({ stagingKey: STAGING, candidateKey: CANDIDATE, sizeBytes: text.length }),
    ).resolves.toEqual({
      sizeBytes: text.length,
      contentType: 'image/png',
      verifiedContentType: null,
    });
    expect(handle.mock.calls[3]?.[0]).toMatchObject({
      headers: { range: `bytes=0-${String(text.length - 1)}` },
    });
  });

  it('copies an opaque intake upload to an immutable candidate in the explicit tenant', async () => {
    const { handle, store } = fixture();
    handle
      .mockResolvedValueOnce(head(PNG.length, 'image/png', 'source'))
      .mockResolvedValueOnce(copied('candidate'))
      .mockResolvedValueOnce(head(PNG.length, 'image/png', 'candidate'))
      .mockResolvedValueOnce(partial(PNG, PNG.length));

    await expect(
      store.copyAndVerifyIntake({
        organizationId: FOREIGN_ORGANIZATION,
        stagingKey: INTAKE_STAGING,
        candidateKey: CANDIDATE,
        sizeBytes: PNG.length,
      }),
    ).rejects.toBeInstanceOf(AttachmentObjectStorageError);
    await expect(
      store.copyAndVerify({
        stagingKey: INTAKE_STAGING,
        candidateKey: CANDIDATE,
        sizeBytes: PNG.length,
      }),
    ).rejects.toBeInstanceOf(AttachmentObjectStorageError);
    expect(handle).not.toHaveBeenCalled();

    await expect(
      store.copyAndVerifyIntake({
        organizationId: ORGANIZATION,
        stagingKey: INTAKE_STAGING,
        candidateKey: CANDIDATE,
        sizeBytes: PNG.length,
      }),
    ).resolves.toEqual({
      sizeBytes: PNG.length,
      contentType: 'image/png',
      verifiedContentType: 'image/png',
    });
    expect(handle).toHaveBeenCalledTimes(4);
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      method: 'HEAD',
      path: `/attachment-test/${INTAKE_STAGING}`,
    });
    expect(handle.mock.calls[1]?.[0]).toMatchObject({
      method: 'PUT',
      path: `/attachment-test/${CANDIDATE}`,
      headers: {
        'x-amz-copy-source': `attachment-test/${INTAKE_STAGING}`,
        'x-amz-copy-source-if-match': '"source"',
        'if-none-match': '*',
      },
    });
  });

  it.each([
    {
      name: 'matches an ICO signature to its registered canonical media type',
      prefix: ICO,
      remaining: 0,
      contentType: 'image/vnd.microsoft.icon',
      verifiedContentType: 'image/vnd.microsoft.icon',
    },
    {
      name: 'preserves the canonical ICO signature when the declared type is PNG',
      prefix: ICO,
      remaining: 0,
      contentType: 'image/png',
      verifiedContentType: 'image/vnd.microsoft.icon',
    },
    {
      name: 'recognizes a Unicode log declared as plain text',
      prefix: Buffer.from('10:00 Atelier Nord — Export terminé\r\n'),
      remaining: 0,
      contentType: 'TEXT/PLAIN',
      verifiedContentType: 'text/plain',
    },
    {
      name: 'accepts a truncated code point when the 4 KiB prefix has more bytes after it',
      prefix: UTF8_SPLIT_PREFIX,
      remaining: 1,
      contentType: 'text/plain',
      verifiedContentType: 'text/plain',
    },
    {
      name: 'rejects a truncated code point at the end of an exact 4 KiB text object',
      prefix: UTF8_SPLIT_PREFIX,
      remaining: 0,
      contentType: 'text/plain',
      verifiedContentType: null,
    },
    {
      name: 'rejects a truncated code point at the end of a short text object',
      prefix: Buffer.from([0x61, 0xe2, 0x82]),
      remaining: 0,
      contentType: 'text/plain',
      verifiedContentType: null,
    },
    {
      name: 'rejects invalid UTF-8 before the end of a text prefix',
      prefix: Buffer.concat([Buffer.from([0xe2, 0x61]), Buffer.alloc(4_094, 0x61)]),
      remaining: 1,
      contentType: 'text/plain',
      verifiedContentType: null,
    },
    {
      name: 'rejects a NUL in otherwise valid UTF-8',
      prefix: Buffer.from('Journal\0Atelier Nord'),
      remaining: 0,
      contentType: 'text/plain',
      verifiedContentType: null,
    },
    {
      name: 'uses the detected binary type over a plain-text declaration',
      prefix: PNG,
      remaining: 0,
      contentType: 'text/plain',
      verifiedContentType: 'image/png',
    },
    {
      name: 'leaves plain-text declarations with parameters unverified',
      prefix: Buffer.from('Journal Atelier Nord'),
      remaining: 0,
      contentType: 'text/plain; charset=utf-8',
      verifiedContentType: null,
    },
  ])('$name', async ({ prefix, remaining, contentType, verifiedContentType }) => {
    const { handle, store } = fixture();
    const sizeBytes = prefix.length + remaining;
    handle
      .mockResolvedValueOnce(head(sizeBytes, contentType, 'source'))
      .mockResolvedValueOnce(copied('candidate'))
      .mockResolvedValueOnce(head(sizeBytes, contentType, 'candidate'))
      .mockResolvedValueOnce(partial(prefix, sizeBytes));

    await expect(
      store.copyAndVerify({ stagingKey: STAGING, candidateKey: CANDIDATE, sizeBytes }),
    ).resolves.toEqual({ sizeBytes, contentType, verifiedContentType });
  });

  it('does not copy staging bytes that exceed the reservation or hard limit', async () => {
    const { handle, store } = fixture();
    handle
      .mockResolvedValueOnce(head(MAX_FILE_BYTES + 1, 'image/png', 'source'))
      .mockResolvedValueOnce(head(PNG.length + 1, 'image/png', 'source'));
    await expect(
      store.copyAndVerify({
        stagingKey: STAGING,
        candidateKey: CANDIDATE,
        sizeBytes: MAX_FILE_BYTES,
      }),
    ).resolves.toEqual({
      sizeBytes: MAX_FILE_BYTES + 1,
      contentType: 'image/png',
      verifiedContentType: null,
    });
    await expect(
      store.copyAndVerify({ stagingKey: STAGING, candidateKey: CANDIDATE, sizeBytes: PNG.length }),
    ).resolves.toEqual({
      sizeBytes: PNG.length + 1,
      contentType: 'image/png',
      verifiedContentType: null,
    });
    expect(handle).toHaveBeenCalledTimes(2);
    expect(handle.mock.calls[0]?.[0]).toMatchObject({ method: 'HEAD' });
    expect(handle.mock.calls[1]?.[0]).toMatchObject({ method: 'HEAD' });
  });

  it('refuses cross-tenant pairs and source reuse before accessing S3', async () => {
    const { handle, store } = fixture();
    const foreign = CANDIDATE.replace(ORGANIZATION, FOREIGN_ORGANIZATION);
    await expect(
      store.copyAndVerify({ stagingKey: STAGING, candidateKey: foreign, sizeBytes: PNG.length }),
    ).rejects.toBeInstanceOf(AttachmentObjectStorageError);
    await expect(
      store.copyAndVerify({ stagingKey: STAGING, candidateKey: STAGING, sizeBytes: PNG.length }),
    ).rejects.toBeInstanceOf(AttachmentObjectStorageError);
    expect(handle).not.toHaveBeenCalled();
  });

  it('treats a missing staged object and a changed source during copy as not ready', async () => {
    const { handle, store } = fixture();
    handle
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(head(PNG.length, 'image/png', 'source'))
      .mockResolvedValueOnce(response(412));
    await expect(
      store.copyAndVerify({ stagingKey: STAGING, candidateKey: CANDIDATE, sizeBytes: PNG.length }),
    ).resolves.toBeNull();
    await expect(
      store.copyAndVerify({ stagingKey: STAGING, candidateKey: CANDIDATE, sizeBytes: PNG.length }),
    ).resolves.toBeNull();
    expect(handle).toHaveBeenCalledTimes(3);
  });

  it('rejects and closes an unbounded range response before consuming its bytes', async () => {
    const { handle, store } = fixture();
    const body = Readable.from([Buffer.alloc(8_192)]);
    const destroy = vi.spyOn(body, 'destroy');
    handle
      .mockResolvedValueOnce(head(8_192, 'image/png', 'source'))
      .mockResolvedValueOnce(copied('candidate'))
      .mockResolvedValueOnce(head(8_192, 'image/png', 'candidate'))
      .mockResolvedValueOnce(response(200, { 'content-length': '8192' }, body));
    await expect(
      store.copyAndVerify({ stagingKey: STAGING, candidateKey: CANDIDATE, sizeBytes: 8_192 }),
    ).rejects.toBeInstanceOf(AttachmentObjectStorageError);
    expect(destroy).toHaveBeenCalled();
  });

  it('signs a download without sending a request and neutralizes filename syntax for browsers', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-20T14:00:00.450Z') });
    const { handle, store } = fixture();
    const signed = await store.signDownload({
      objectKey: CANDIDATE,
      fileName: 'résumé "équipe".png',
    });
    const url = new URL(signed.url);
    expect(url.origin).toBe('https://files.example.test');
    expect(url.pathname).toBe(`/attachment-test/${CANDIDATE}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(url.searchParams.get('response-cache-control')).toBe('private, no-store');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="r_sum_ __quipe_.png"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9%20%22%C3%A9quipe%22.png',
    );
    expect(signed.expiresAt).toBe('2026-11-20T14:05:00.000Z');
    expect(handle).not.toHaveBeenCalled();
  });

  it('deletes idempotently without leaking provider diagnostics or retrying a failed request', async () => {
    const { handle, store } = fixture();
    handle
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(404))
      .mockRejectedValueOnce(new Error('Provider diagnostics with storage locations'));
    await expect(store.deleteObject(CANDIDATE, 'preserve')).resolves.toBeUndefined();
    await expect(store.deleteObject(CANDIDATE, 'preserve')).resolves.toBeUndefined();
    await expect(store.deleteObject(CANDIDATE, 'preserve')).rejects.toThrow(
      'Object storage could not process the attachment.',
    );
    expect(handle).toHaveBeenCalledTimes(3);
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      method: 'DELETE',
      path: `/attachment-test/${CANDIDATE}`,
    });
  });

  it('deletes opaque intake staging only through the tenant-bound eraser', async () => {
    const { handle, store } = fixture();
    handle.mockResolvedValueOnce(response(204)).mockResolvedValueOnce(response(404));

    await expect(store.deleteObject(INTAKE_STAGING, 'transient')).rejects.toBeInstanceOf(
      AttachmentObjectStorageError,
    );
    await expect(
      store.deleteIntakeObject({
        organizationId: FOREIGN_ORGANIZATION,
        objectKey: CANDIDATE,
        retention: 'preserve',
      }),
    ).rejects.toBeInstanceOf(AttachmentObjectStorageError);
    await expect(
      store.deleteIntakeObject({
        organizationId: 'invalid',
        objectKey: INTAKE_STAGING,
        retention: 'transient',
      }),
    ).rejects.toBeInstanceOf(AttachmentObjectStorageError);
    expect(handle).not.toHaveBeenCalled();

    await expect(
      store.deleteIntakeObject({
        organizationId: ORGANIZATION,
        objectKey: INTAKE_STAGING,
        retention: 'transient',
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.deleteIntakeObject({
        organizationId: ORGANIZATION,
        objectKey: CANDIDATE,
        retention: 'preserve',
      }),
    ).resolves.toBeUndefined();
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      method: 'DELETE',
      path: `/attachment-test/${INTAKE_STAGING}`,
    });
    expect(handle.mock.calls[1]?.[0]).toMatchObject({
      method: 'DELETE',
      path: `/attachment-test/${CANDIDATE}`,
    });
  });

  it('erases all pages of exact-key versions and markers while leaving lookalike keys alone', async () => {
    const { handle, store } = fixture(true);
    const page = (elements: string) =>
      response(200, {}, Buffer.from(`<ListVersionsResult>${elements}</ListVersionsResult>`));
    const deleted = response(200, {}, Buffer.from('<DeleteResult/>'));
    handle
      .mockResolvedValueOnce(
        page(
          `<IsTruncated>true</IsTruncated><Version><Key>${STAGING}</Key><VersionId>first</VersionId></Version><DeleteMarker><Key>${STAGING}</Key><VersionId>marker</VersionId></DeleteMarker>`,
        ),
      )
      .mockResolvedValueOnce(deleted)
      .mockResolvedValueOnce(
        page(
          `<IsTruncated>false</IsTruncated><Version><Key>${STAGING}</Key><VersionId>second</VersionId></Version><Version><Key>${STAGING}-other</Key><VersionId>foreign</VersionId></Version>`,
        ),
      )
      .mockResolvedValueOnce(deleted)
      .mockResolvedValueOnce(
        page(
          `<IsTruncated>false</IsTruncated><Version><Key>${STAGING}-other</Key><VersionId>foreign</VersionId></Version>`,
        ),
      )
      .mockResolvedValueOnce(page('<IsTruncated>false</IsTruncated>'));

    await expect(store.deleteObject(STAGING, 'transient')).resolves.toBeUndefined();
    expect(handle).toHaveBeenCalledTimes(6);
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      method: 'GET',
      query: { prefix: STAGING, versions: '', 'max-keys': '100' },
    });
    const first: unknown = handle.mock.calls[1]?.[0];
    const second: unknown = handle.mock.calls[3]?.[0];
    expect(first).toMatchObject({ method: 'POST', query: { delete: '' } });
    expect(first).toHaveProperty('body', expect.stringContaining('<VersionId>first</VersionId>'));
    expect(first).toHaveProperty('body', expect.stringContaining('<VersionId>marker</VersionId>'));
    expect(second).toHaveProperty('body', expect.stringContaining('<VersionId>second</VersionId>'));
    expect(second).not.toHaveProperty('body', expect.stringContaining('foreign'));
    expect(handle.mock.calls[5]?.[0]).toMatchObject({
      query: { prefix: `attachment-restore-pins/${STAGING}`, versions: '' },
    });
  });

  it('uses a delete marker for a restorable object even when transient version erasure is enabled', async () => {
    const { handle, store } = fixture(true);
    handle.mockResolvedValueOnce(response(204));
    await expect(store.deleteObject(CANDIDATE, 'preserve')).resolves.toBeUndefined();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      method: 'DELETE',
      path: `/attachment-test/${CANDIDATE}`,
    });
    expect(handle.mock.calls[0]?.[0]).not.toHaveProperty('query.versionId');
  });

  it('retries rather than erases when it cannot verify a candidate restore proof', async () => {
    const { handle, store } = fixture(true);
    handle.mockResolvedValueOnce(response(403));
    await expect(store.deleteObject(CANDIDATE, 'candidate')).rejects.toBeInstanceOf(
      AttachmentObjectStorageError,
    );
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      method: 'GET',
      query: { prefix: `attachment-restore-pins/${CANDIDATE}`, versions: '' },
    });
  });

  it('rejects an incomplete version listing before erasing a candidate', async () => {
    const { handle, store } = fixture(true);
    handle.mockResolvedValueOnce(response(200, {}, Buffer.from('<ListVersionsResult/>')));
    await expect(store.deleteObject(CANDIDATE, 'candidate')).rejects.toBeInstanceOf(
      AttachmentObjectStorageError,
    );
    expect(handle).toHaveBeenCalledOnce();
  });

  it('does not acknowledge a partial version deletion', async () => {
    const { handle, store } = fixture(true);
    handle
      .mockResolvedValueOnce(
        response(
          200,
          {},
          Buffer.from(
            `<ListVersionsResult><IsTruncated>false</IsTruncated><Version><Key>${STAGING}</Key><VersionId>first</VersionId></Version></ListVersionsResult>`,
          ),
        ),
      )
      .mockResolvedValueOnce(
        response(
          200,
          {},
          Buffer.from(
            '<DeleteResult><Error><Code>AccessDenied</Code><VersionId>first</VersionId></Error></DeleteResult>',
          ),
        ),
      );
    await expect(store.deleteObject(STAGING, 'transient')).rejects.toBeInstanceOf(
      AttachmentObjectStorageError,
    );
    expect(handle).toHaveBeenCalledTimes(2);
  });
});
