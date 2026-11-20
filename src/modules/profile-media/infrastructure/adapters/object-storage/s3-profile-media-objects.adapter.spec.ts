import type { S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProfileMediaUnavailable } from '../../../application/models/media/profile-media-unavailable.model.js';
import { S3ProfileMediaObjects } from './s3-profile-media-objects.adapter.js';

const owner = {
  kind: 'organization-logo',
  id: '11111111-2222-4333-8444-555555555555',
} as const;
const uploadId = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01';
const candidateId = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b02';
const staging = `profile-media/staging/${uploadId}`;
const candidate = `profile-media/candidate/${candidateId}`;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/VZkAAAAASUVORK5CYII=',
  'base64',
);
const source = { owner, uploadId, contentType: 'image/png', sizeBytes: png.length };
const etag = '"expected-generation"';

type Handler = S3Client['config']['requestHandler'];
type Response = Awaited<ReturnType<Handler['handle']>>;
const objects: S3ProfileMediaObjects[] = [];

function fixture() {
  const handle = vi.fn<Handler['handle']>();
  const storage = new S3ProfileMediaObjects(
    'profile-test',
    {
      credentials: { accessKeyId: 'unit-fixture', secretAccessKey: 'not-a-real-credential' },
      region: 'garage',
      endpoint: 'https://store.internal.example.test',
      forcePathStyle: true,
      requestHandler: { handle, destroy: vi.fn() },
    },
    'https://files.example.test',
  );
  objects.push(storage);
  return { handle, storage };
}

function response(
  statusCode: number,
  headers: Record<string, string> = {},
  body: Buffer | Readable = Buffer.alloc(0),
): Response {
  return { response: { statusCode, headers, body } };
}

function head(contentType = source.contentType): Response {
  return response(200, {
    'content-type': contentType,
    'content-length': String(png.length),
    etag,
  });
}

function partial(body: Readable, version = etag): Response {
  return response(
    206,
    {
      'content-type': source.contentType,
      'content-range': `bytes 0-${String(png.length - 1)}/${String(png.length)}`,
      etag: version,
    },
    body,
  );
}

afterEach(() => {
  for (const storage of objects.splice(0)) storage.onModuleDestroy();
  vi.useRealTimers();
});

describe('S3ProfileMediaObjects', () => {
  it('signs only the opaque staging key, exact MIME and owner expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T08:08:12.621Z'));
    const { handle, storage } = fixture();
    const expiresAt = new Date('2026-11-20T08:13:12Z');
    const signed = await storage.sign({ ...source, expiresAt });

    expect(signed).toMatchObject({
      method: 'POST',
      url: 'https://files.example.test/profile-test',
      uploadId,
      expiresAt: expiresAt.toISOString(),
      fields: { key: staging, 'Content-Type': source.contentType },
    });
    const encodedPolicy = signed.fields.Policy;
    if (encodedPolicy === undefined) throw new Error('Missing signed policy in test.');
    const policy: unknown = JSON.parse(Buffer.from(encodedPolicy, 'base64').toString('utf-8'));
    expect(policy).toMatchObject({
      expiration: '2026-11-20T08:13:12Z',
      conditions: expect.arrayContaining([
        ['content-length-range', 1, 5 * 1024 * 1024],
        { 'Content-Type': source.contentType },
        { key: staging },
      ]) as unknown,
    });
    expect(JSON.stringify(policy)).not.toContain(owner.id);
    expect(handle).not.toHaveBeenCalled();
  });

  it('never signs after the deadline or at an expiry the SDK cannot represent exactly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T08:08:12.621Z'));
    const { handle, storage } = fixture();
    await expect(
      storage.sign({ ...source, expiresAt: new Date('2026-11-20T08:08:12Z') }),
    ).rejects.toBeInstanceOf(ProfileMediaUnavailable);
    await expect(
      storage.sign({ ...source, expiresAt: new Date('2026-11-20T08:13:12.641Z') }),
    ).rejects.toBeInstanceOf(ProfileMediaUnavailable);
    expect(handle).not.toHaveBeenCalled();
  });

  it('pins one internal GET to the HEAD ETag and accepts the exact chunked image', async () => {
    const { handle, storage } = fixture();
    const body = Readable.from([png.subarray(0, 32), png.subarray(32)]);
    handle.mockResolvedValueOnce(head()).mockResolvedValueOnce(partial(body));

    await expect(storage.readSource(source)).resolves.toEqual(png);
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      method: 'HEAD',
      path: `/profile-test/${staging}`,
      hostname: 'store.internal.example.test',
    });
    expect(handle.mock.calls[1]?.[0]).toMatchObject({
      method: 'GET',
      path: `/profile-test/${staging}`,
      headers: { range: `bytes=0-${String(png.length)}`, 'if-match': etag },
    });
    expect(body.destroyed).toBe(true);
  });

  it('refuses a staging MIME different from the reservation before downloading it', async () => {
    const { handle, storage } = fixture();
    handle.mockResolvedValueOnce(head('image/svg+xml'));

    await expect(storage.readSource(source)).rejects.toMatchObject({ reason: 'invalid-image' });
    expect(handle).toHaveBeenCalledOnce();
  });

  it('returns no bytes when a staging upload changes before the conditional read', async () => {
    const { handle, storage } = fixture();
    handle
      .mockResolvedValueOnce(head())
      .mockResolvedValueOnce(
        response(412, {}, Buffer.from('<Error><Code>PreconditionFailed</Code></Error>')),
      );

    await expect(storage.readSource(source)).resolves.toBeNull();
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('destroys an inconsistent response as soon as a chunk reaches the sentinel byte', async () => {
    const { handle, storage } = fixture();
    const body = Readable.from([png, Buffer.alloc(1), Buffer.alloc(3)]);
    handle.mockResolvedValueOnce(head()).mockResolvedValueOnce(partial(body));

    await expect(storage.readSource(source)).rejects.toBeInstanceOf(ProfileMediaUnavailable);
    expect(body.destroyed).toBe(true);
  });

  it('rejects redirects without following a destination supplied by object storage', async () => {
    const { handle, storage } = fixture();
    handle.mockResolvedValueOnce(response(301, { location: 'https://other.example.test/image' }));

    await expect(storage.readSource(source)).rejects.toBeInstanceOf(ProfileMediaUnavailable);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('makes candidate writes create-only and reads their bytes from the private endpoint', async () => {
    const { handle, storage } = fixture();
    handle
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(partial(Readable.from([png])));

    await storage.putCandidate({ owner, uploadId, candidateId, png });
    await expect(storage.readCandidate({ ...source, candidateId })).resolves.toEqual(png);
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      method: 'PUT',
      hostname: 'store.internal.example.test',
      path: `/profile-test/${candidate}`,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'private, no-store',
        'if-none-match': '*',
      },
    });
    expect(handle.mock.calls[1]?.[0]).toMatchObject({
      method: 'GET',
      hostname: 'store.internal.example.test',
      path: `/profile-test/${candidate}`,
    });
  });

  it('lists a bounded page of only canonical opaque keys and erases the leased physical role', async () => {
    const { handle, storage } = fixture();
    const contents = [staging, candidate, 'profile-media/staging/test.png']
      .map((key) => `<Contents><Key>${key}</Key></Contents>`)
      .join('');
    handle
      .mockResolvedValueOnce(
        response(
          200,
          {},
          Buffer.from(
            `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>index-b</NextContinuationToken>${contents}</ListBucketResult>`,
          ),
        ),
      )
      .mockResolvedValueOnce(response(204));

    await expect(
      storage.listProfileMediaObjects('index-a', new AbortController().signal),
    ).resolves.toEqual({
      objects: [
        { role: 'staging', objectId: uploadId },
        { role: 'candidate', objectId: candidateId },
      ],
      next: 'index-b',
    });
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      query: {
        prefix: 'profile-media/',
        'max-keys': '500',
        'continuation-token': 'index-a',
      },
    });
    await storage.erase({
      owner,
      uploadId,
      objectId: uploadId,
      generation: 1,
      leaseId: candidateId,
    });
    expect(handle.mock.calls[1]?.[0]).toMatchObject({
      method: 'DELETE',
      path: `/profile-test/${staging}`,
    });
  });
});
