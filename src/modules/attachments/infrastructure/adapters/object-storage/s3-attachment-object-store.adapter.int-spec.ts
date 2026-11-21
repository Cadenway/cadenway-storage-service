import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CopyObjectCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { UploadCapability } from '../../../application/models/attachment/upload-capability.model.js';
import { S3AttachmentObjectStore } from './s3-attachment-object-store.adapter.js';

const IMAGE =
  'dxflrs/garage:v2.5.0@sha256:677e5b758e4425a325b811c425c026bf35a4bf42f7ddbaa773de3f4fd779a5a5';
const BUCKET = 'attachments-test';
const ORGANIZATION = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const ATTACHMENT = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01';
const STAGING = `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b02`;
const CANDIDATE = `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b03`;
const LIMIT = 25 * 1024 * 1024;
const ORIGIN = 'https://app.example.test';
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/VZkAAAAASUVORK5CYII=',
    'base64',
  ),
);

/** Sends the form exactly as a browser sends the provided upload capability. */
async function upload(
  capability: UploadCapability,
  bytes: Uint8Array,
  origin = ORIGIN,
): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(capability.fields)) form.append(name, value);
  form.append('file', new Blob([Uint8Array.from(bytes)], { type: 'image/png' }), 'sprint-14.png');
  return fetch(capability.url, { method: 'POST', headers: { Origin: origin }, body: form });
}

describe('Garage-backed attachment transfers', () => {
  const container = `cadenway-storage-garage-test-${String(process.pid)}-${randomBytes(4).toString('hex')}`;
  const accessKeyId = `GK${randomBytes(16).toString('hex')}`;
  const secretAccessKey = randomBytes(32).toString('hex');
  const rpcSecret = randomBytes(32).toString('hex');
  const dockerEnvironment = { ...process.env };
  delete dockerEnvironment.DOCKER_HOST;
  delete dockerEnvironment.DOCKER_CONTEXT;
  let directory: string | undefined;
  let store: S3AttachmentObjectStore | undefined;
  let client: S3Client | undefined;
  let endpoint = '';
  let started = false;

  beforeAll(async () => {
    const context = execFileSync('docker', ['context', 'show'], {
      encoding: 'utf8',
      env: dockerEnvironment,
    }).trim();
    const dockerHost = execFileSync(
      'docker',
      ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'],
      { encoding: 'utf8', env: dockerEnvironment },
    ).trim();
    if (!dockerHost.startsWith('npipe://') && !dockerHost.startsWith('unix://')) {
      throw new Error('The Garage test requires a local Docker socket');
    }
    directory = mkdtempSync(join(tmpdir(), 'cadenway-garage-test-'));
    const configuration = join(directory, 'garage.toml');
    writeFileSync(
      configuration,
      [
        'metadata_dir = "/var/lib/garage/meta"',
        'data_dir = "/var/lib/garage/data"',
        'db_engine = "sqlite"',
        'replication_factor = 1',
        'rpc_bind_addr = "0.0.0.0:3901"',
        'rpc_public_addr = "127.0.0.1:3901"',
        '[s3_api]',
        's3_region = "garage"',
        'api_bind_addr = "0.0.0.0:3900"',
        '[admin]',
        'api_bind_addr = "0.0.0.0:3903"',
        '',
      ].join('\n'),
    );
    execFileSync(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        container,
        '--publish',
        '127.0.0.1::3900',
        '--tmpfs',
        '/var/lib/garage:rw,size=192m',
        '--mount',
        `type=bind,source=${configuration},target=/etc/garage.toml,readonly`,
        '--env',
        'GARAGE_RPC_SECRET',
        '--env',
        'GARAGE_DEFAULT_ACCESS_KEY',
        '--env',
        'GARAGE_DEFAULT_SECRET_KEY',
        '--env',
        'GARAGE_DEFAULT_BUCKET',
        IMAGE,
        '/garage',
        'server',
        '--single-node',
        '--default-bucket',
      ],
      {
        env: {
          ...dockerEnvironment,
          GARAGE_RPC_SECRET: rpcSecret,
          GARAGE_DEFAULT_ACCESS_KEY: accessKeyId,
          GARAGE_DEFAULT_SECRET_KEY: secretAccessKey,
          GARAGE_DEFAULT_BUCKET: BUCKET,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    started = true;
    const port = execFileSync('docker', ['port', container, '3900/tcp'], {
      encoding: 'utf8',
      env: dockerEnvironment,
    })
      .trim()
      .split(':')
      .at(-1);
    if (port === undefined || !/^\d+$/u.test(port)) throw new Error('Garage has no published port');
    endpoint = `http://127.0.0.1:${port}`;
    const configurationS3 = {
      region: 'garage',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      maxAttempts: 1,
    };
    client = new S3Client(configurationS3);
    store = new S3AttachmentObjectStore(BUCKET, configurationS3, endpoint);
    await vi.waitFor(
      async () => {
        await client?.send(new HeadBucketCommand({ Bucket: BUCKET }));
      },
      { timeout: 30_000, interval: 200 },
    );
    await client.send(
      new PutBucketCorsCommand({
        Bucket: BUCKET,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [ORIGIN],
              AllowedMethods: ['GET', 'POST'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag'],
            },
          ],
        },
      }),
    );
  });

  afterAll(() => {
    store?.onModuleDestroy();
    client?.destroy();
    try {
      if (started)
        execFileSync('docker', ['rm', '--force', container], {
          stdio: 'ignore',
          env: dockerEnvironment,
        });
    } finally {
      if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts a browser upload and keeps the verified copy after staging is replaced', async () => {
    if (store === undefined || client === undefined) throw new Error('Garage was not initialized');
    const capability = await store.signUpload({
      attachmentId: ATTACHMENT,
      stagingKey: STAGING,
      contentType: 'image/png',
      expiresAt: new Date(Date.now() + 300_000),
    });
    const preflight = await fetch(capability.url, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const foreignPreflight = await fetch(capability.url, {
      method: 'OPTIONS',
      headers: { Origin: 'https://other.example.test', 'Access-Control-Request-Method': 'POST' },
    });
    const foreignCapability = await store.signUpload({
      attachmentId: ATTACHMENT,
      stagingKey: `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b05`,
      contentType: 'image/png',
      expiresAt: new Date(Date.now() + 300_000),
    });
    const foreignUpload = await upload(foreignCapability, PNG, 'https://other.example.test');
    expect(foreignPreflight.status).toBe(403);
    expect(foreignPreflight.headers.get('access-control-allow-methods')).toBeNull();
    expect(foreignPreflight.headers.get('access-control-allow-headers')).toBeNull();
    // Simple multipart POSTs can reach Garage, but their response is hidden from another origin.
    expect(foreignUpload.status).toBe(204);
    expect(foreignUpload.headers.get('access-control-allow-origin')).toBeNull();
    const response = await upload(capability, PNG);
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await store.copyAndVerify({ stagingKey: STAGING, candidateKey: CANDIDATE })).toEqual({
      sizeBytes: PNG.length,
      contentType: 'image/png',
      verifiedContentType: 'image/png',
    });
    expect((await upload(capability, Uint8Array.from([1, 2, 3]))).status).toBe(204);
    await expect(
      client.send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          Key: `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b06`,
          CopySource: `${BUCKET}/${STAGING}`,
          CopySourceIfMatch: '"incorrect-source-etag"',
        }),
      ),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    // Each copy attempt registers a distinct candidate before copying and never reuses an elected key.
    const signed = await store.signDownload({ objectKey: CANDIDATE, fileName: 'sprint-14.png' });
    const download = await fetch(signed.url, { headers: { Origin: ORIGIN } });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('attachment;');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(PNG);
  });

  it('lists managed attachment keys and skips other physical objects', async () => {
    if (store === undefined || client === undefined) throw new Error('Garage was not initialized');
    const inventoryClient = client;
    const managed = `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b09`;
    const unknown = `org/${ORGANIZATION}/fixture`;
    const outside = 'other/fixture';
    await Promise.all(
      [managed, unknown, outside].map((Key) =>
        inventoryClient.send(
          new PutObjectCommand({ Bucket: BUCKET, Key, Body: 'inventory-fixture' }),
        ),
      ),
    );

    const page = await store.listAttachmentObjects(null, new AbortController().signal);
    const keys = page.objects.map(({ objectKey }) => objectKey);
    expect(keys).toContain(managed);
    expect(keys).not.toContain(unknown);
    expect(keys).not.toContain(outside);
    expect(page.next).toBeNull();
  });

  it('accepts a file of 25 MiB and refuses one additional byte', async () => {
    if (store === undefined) throw new Error('Garage was not initialized');
    const capability = await store.signUpload({
      attachmentId: ATTACHMENT,
      stagingKey: STAGING,
      contentType: 'image/png',
      expiresAt: new Date(Date.now() + 300_000),
    });
    const maximum = new Uint8Array(LIMIT);
    maximum.set(PNG);
    expect((await upload(capability, maximum)).status).toBe(204);
    const tooLarge = new Uint8Array(LIMIT + 1);
    tooLarge.set(PNG);
    expect((await upload(capability, tooLarge)).status).toBeGreaterThanOrEqual(400);
    const nextCandidate = `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b04`;
    expect(await store.copyAndVerify({ stagingKey: STAGING, candidateKey: nextCandidate })).toEqual(
      {
        sizeBytes: LIMIT,
        contentType: 'image/png',
        verifiedContentType: 'image/png',
      },
    );
  });
});
