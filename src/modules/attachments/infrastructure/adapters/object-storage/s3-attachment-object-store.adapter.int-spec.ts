import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  PutBucketCorsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProfileMediaImageProcessor } from '../../../../profile-media/infrastructure/adapters/image-processing/profile-media-image-processor.adapter.js';
import { S3ProfileMediaObjects } from '../../../../profile-media/infrastructure/adapters/object-storage/s3-profile-media-objects.adapter.js';
import type { UploadCapability } from '../../../application/models/attachment/upload-capability.model.js';
import { S3AttachmentObjectStore } from './s3-attachment-object-store.adapter.js';

const IMAGE =
  'dxflrs/garage:v2.5.0@sha256:677e5b758e4425a325b811c425c026bf35a4bf42f7ddbaa773de3f4fd779a5a5';
const SEAWEEDFS =
  'chrislusf/seaweedfs@sha256:4b42c212543a0acd4c0e675215ecdcaf62a186ef98def76c7e12701871222d15';
const BUCKET = 'attachments-test';
const ORGANIZATION = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const ATTACHMENT = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01';
const STAGING = `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b02`;
const CANDIDATE = `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b03`;
const INTAKE_STAGING = 'intake/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b04';
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
  capability: Pick<UploadCapability, 'url' | 'fields'>,
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
  let profileStore: S3ProfileMediaObjects | undefined;
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
    profileStore = new S3ProfileMediaObjects(BUCKET, configurationS3, endpoint);
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
    profileStore?.onModuleDestroy();
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
      sizeBytes: PNG.length,
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
      sizeBytes: PNG.length,
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
    expect(
      (await upload(capability, new Uint8Array(PNG.length + 1))).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      await store.copyAndVerify({
        stagingKey: STAGING,
        candidateKey: CANDIDATE,
        sizeBytes: PNG.length,
      }),
    ).toEqual({
      sizeBytes: PNG.length,
      contentType: 'image/png',
      verifiedContentType: 'image/png',
    });
    await store.retainCandidate(CANDIDATE);
    await store.retainCandidate(CANDIDATE);
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

  it('enforces a profile image POST policy and persists only its private derivative', async () => {
    if (profileStore === undefined || client === undefined) {
      throw new Error('Garage was not initialized');
    }
    const owner = { kind: 'organization-logo', id: ORGANIZATION } as const;
    const uploadId = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b10';
    const candidateId = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b11';
    const stagingKey = `profile-media/staging/${uploadId}`;
    const candidateKey = `profile-media/candidate/${candidateId}`;
    const leaseId = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b12';
    const png = await sharp({
      create: { width: 640, height: 640, channels: 3, background: '#31578c' },
    })
      .png()
      .toBuffer();
    const source = { owner, uploadId, contentType: 'image/png', sizeBytes: png.byteLength };
    const expiresAt = new Date(Math.floor(Date.now() / 1_000) * 1_000 + 120_000);
    const capability = await profileStore.sign({ ...source, expiresAt });
    expect(capability).toMatchObject({
      method: 'POST',
      expiresAt: expiresAt.toISOString(),
      fields: { key: stagingKey, 'Content-Type': 'image/png' },
    });
    const encodedPolicy = capability.fields.Policy;
    if (encodedPolicy === undefined) throw new Error('The POST capability has no policy');
    const policy: unknown = JSON.parse(Buffer.from(encodedPolicy, 'base64').toString('utf8'));
    expect(policy).toMatchObject({
      expiration: expiresAt.toISOString().replace('.000Z', 'Z'),
      conditions: expect.arrayContaining([
        { key: stagingKey },
        { 'Content-Type': 'image/png' },
        ['content-length-range', 1, source.sizeBytes],
      ]) as unknown,
    });
    expect((await upload(capability, png)).status).toBe(204);

    await expect(
      client.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: stagingKey,
          IfMatch: '"incorrect-staging-etag"',
          Range: `bytes=0-${String(png.byteLength)}`,
        }),
      ),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    const pinned = await profileStore.readSource(source);
    expect(pinned).toEqual(png);
    if (pinned === null) throw new Error('The uploaded source could not be read');
    const result = await new ProfileMediaImageProcessor().transform({
      kind: owner.kind,
      contentType: source.contentType,
      bytes: pinned,
      candidateId,
    });
    expect(result.verification.derivative).toMatchObject({ width: 512, height: 512 });
    const candidate = { owner, uploadId, candidateId, sizeBytes: result.png.byteLength };
    await profileStore.putCandidate({ ...candidate, png: result.png });
    await expect(
      client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: candidateKey })),
    ).resolves.toMatchObject({ ContentType: 'image/png', CacheControl: 'private, no-store' });

    const cleanup = { owner, uploadId, generation: 1, leaseId, retention: 'preserve' } as const;
    await profileStore.erase({ ...cleanup, objectId: uploadId });
    await expect(profileStore.readSource(source)).resolves.toBeNull();
    await expect(profileStore.readCandidate(candidate)).resolves.toEqual(result.png);
    await profileStore.erase({ ...cleanup, objectId: candidateId });
    await expect(profileStore.readCandidate(candidate)).resolves.toBeNull();

    const expiredSource = { ...source, uploadId: '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b13' };
    const shortExpiry = new Date(Math.floor(Date.now() / 1_000) * 1_000 + 3_000);
    const expiring = await profileStore.sign({ ...expiredSource, expiresAt: shortExpiry });
    expect(expiring.expiresAt).toBe(shortExpiry.toISOString());
    await delay(shortExpiry.getTime() - Date.now() + 1_000);
    const expiredUpload = await upload(expiring, png);
    expect(expiredUpload.status).toBe(400);
    expect(await expiredUpload.text()).toContain('Expiration date is in the past');
    await expect(profileStore.readSource(expiredSource)).resolves.toBeNull();
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

  it('signs, verifies and erases an opaque intake upload while retaining its elected bytes', async () => {
    if (store === undefined) throw new Error('Garage was not initialized');
    const stagingKey = 'intake/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b11';
    const candidateKey = `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b12`;
    const expiresAt = new Date(Date.now() + 180_000);
    const capability = await store.signIntakeUpload({
      organizationId: ORGANIZATION,
      attachmentId: ATTACHMENT,
      stagingKey,
      contentType: 'image/png',
      sizeBytes: PNG.length,
      expiresAt,
    });
    expect(capability.fields.key).toBe(stagingKey);
    expect(new Date(capability.expiresAt).getTime()).toBeLessThanOrEqual(expiresAt.getTime());
    const response = await upload(capability, PNG);
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    await expect(
      store.copyAndVerifyIntake({
        organizationId: ORGANIZATION,
        stagingKey,
        candidateKey,
        sizeBytes: PNG.length,
      }),
    ).resolves.toEqual({
      sizeBytes: PNG.length,
      contentType: 'image/png',
      verifiedContentType: 'image/png',
    });

    const signal = new AbortController().signal;
    const page = await store.listIntakeObjects(null, signal);
    expect(page.objects).toEqual([{ objectKey: stagingKey }]);
    await store.deleteIntakeObject({
      organizationId: ORGANIZATION,
      objectKey: stagingKey,
      retention: 'transient',
    });
    expect((await store.listIntakeObjects(null, signal)).objects).toEqual([]);
    const signed = await store.signDownload({ objectKey: candidateKey, fileName: 'sprint-14.png' });
    const download = await fetch(signed.url);
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(PNG);
  });

  it('accepts a file of 25 MiB and refuses one additional byte', async () => {
    if (store === undefined) throw new Error('Garage was not initialized');
    const capability = await store.signUpload({
      attachmentId: ATTACHMENT,
      stagingKey: STAGING,
      contentType: 'image/png',
      sizeBytes: LIMIT,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const maximum = new Uint8Array(LIMIT);
    maximum.set(PNG);
    expect((await upload(capability, maximum)).status).toBe(204);
    const tooLarge = new Uint8Array(LIMIT + 1);
    tooLarge.set(PNG);
    expect((await upload(capability, tooLarge)).status).toBeGreaterThanOrEqual(400);
    const nextCandidate = `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b04`;
    expect(
      await store.copyAndVerify({
        stagingKey: STAGING,
        candidateKey: nextCandidate,
        sizeBytes: LIMIT,
      }),
    ).toEqual({
      sizeBytes: LIMIT,
      contentType: 'image/png',
      verifiedContentType: 'image/png',
    });
  });
});

describe('versioned SeaweedFS object erasure', () => {
  it('drains staging versions and markers while keeping a protected candidate restorable after a rewind', async () => {
    const container = `cadenway-storage-seaweedfs-test-${String(process.pid)}-${randomBytes(4).toString('hex')}`;
    const environment = { ...process.env };
    delete environment.DOCKER_HOST;
    delete environment.DOCKER_CONTEXT;
    const docker = (...args: readonly string[]): string =>
      execFileSync('docker', args, { encoding: 'utf8', env: environment }).trim();
    const dockerHost = docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}');
    if (!dockerHost.startsWith('npipe://') && !dockerHost.startsWith('unix://')) {
      throw new Error('The versioned bucket test requires a local Docker socket.');
    }
    docker(
      'run',
      '--detach',
      '--rm',
      '--name',
      container,
      '--publish',
      '127.0.0.1::8333',
      '--tmpfs',
      '/data:rw,size=192m',
      SEAWEEDFS,
      'server',
      '-dir=/data',
      '-s3',
      '-s3.port=8333',
      '-ip=127.0.0.1',
      '-ip.bind=0.0.0.0',
    );
    let client: S3Client | undefined;
    let store: S3AttachmentObjectStore | undefined;
    let profileStore: S3ProfileMediaObjects | undefined;
    try {
      const port = docker('port', container, '8333/tcp').split(':').at(-1);
      if (port === undefined || !/^\d+$/u.test(port)) {
        throw new Error('SeaweedFS has no published port.');
      }
      const endpoint = `http://127.0.0.1:${port}`;
      const configuration = {
        region: 'us-east-1',
        endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: 'versioning-fixture', secretAccessKey: 'versioning-fixture' },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        maxAttempts: 1,
      } as const;
      const s3 = new S3Client(configuration);
      client = s3;
      const objectStore = new S3AttachmentObjectStore(BUCKET, configuration, endpoint, true);
      store = objectStore;
      const profiles = new S3ProfileMediaObjects(BUCKET, configuration, endpoint, true);
      profileStore = profiles;
      await vi.waitFor(() => s3.send(new ListBucketsCommand({})), {
        timeout: 30_000,
        interval: 200,
      });
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
      await s3.send(
        new PutBucketVersioningCommand({
          Bucket: BUCKET,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      );

      const capability = await objectStore.signUpload({
        attachmentId: ATTACHMENT,
        stagingKey: STAGING,
        contentType: 'image/png',
        sizeBytes: PNG.length,
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect((await upload(capability, PNG)).status).toBe(204);
      expect((await upload(capability, PNG)).status).toBe(204);
      const candidate = await s3.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: CANDIDATE, Body: PNG }),
      );
      await objectStore.retainCandidate(CANDIDATE);
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: STAGING }));
      await s3.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: `attachment-restore-pins/${CANDIDATE}` }),
      );
      const listVersions = (Key: string) =>
        s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: Key }));
      const staged = await listVersions(STAGING);
      expect(staged.Versions).toHaveLength(2);
      expect(staged.DeleteMarkers).toHaveLength(1);
      const inventorySignal = AbortSignal.timeout(10_000);
      const attachmentPage = await objectStore.listAttachmentObjects(null, inventorySignal);
      expect(attachmentPage.objects).toEqual(
        expect.arrayContaining([
          { organizationId: ORGANIZATION, objectKey: STAGING, transientOnly: true },
          { organizationId: ORGANIZATION, objectKey: CANDIDATE },
        ]),
      );
      expect(attachmentPage.objects.filter(({ objectKey }) => objectKey === STAGING)).toHaveLength(
        1,
      );
      await objectStore.deleteObject(STAGING, 'transient');
      const cleared = await listVersions(STAGING);
      expect(cleared.Versions ?? []).toEqual([]);
      expect(cleared.DeleteMarkers ?? []).toEqual([]);

      // A restored database may see the previously elected key as an unproven candidate.
      await objectStore.deleteObject(CANDIDATE, 'candidate');
      const retained = await listVersions(CANDIDATE);
      expect(retained.DeleteMarkers).toHaveLength(1);
      expect(retained.Versions).toEqual([
        expect.objectContaining({ Key: CANDIDATE, VersionId: candidate.VersionId }),
      ]);
      const recoverable = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: CANDIDATE, VersionId: candidate.VersionId }),
      );
      expect(await recoverable.Body?.transformToByteArray()).toEqual(PNG);

      const rejectedKey = `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b22`;
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: rejectedKey, Body: PNG }));
      await objectStore.retainCandidate(rejectedKey);
      await objectStore.deleteObject(rejectedKey, 'transient');
      const rejected = await listVersions(rejectedKey);
      const releasedProof = await listVersions(`attachment-restore-pins/${rejectedKey}`);
      expect(rejected.Versions ?? []).toEqual([]);
      expect(releasedProof.Versions ?? []).toEqual([]);

      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: INTAKE_STAGING, Body: PNG }));
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: INTAKE_STAGING }));
      const intakePage = await objectStore.listIntakeObjects(null, inventorySignal);
      expect(intakePage.objects).toContainEqual({ objectKey: INTAKE_STAGING, transientOnly: true });
      await objectStore.deleteIntakeObject({
        organizationId: ORGANIZATION,
        objectKey: INTAKE_STAGING,
        retention: 'transient',
      });
      expect((await listVersions(INTAKE_STAGING)).Versions ?? []).toEqual([]);

      const avatar = { kind: 'avatar', id: ORGANIZATION } as const;
      const logo = { kind: 'organization-logo', id: ORGANIZATION } as const;
      const avatarUpload = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b31';
      const avatarCandidate = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b32';
      const logoUpload = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b33';
      const logoCandidate = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b34';
      const unclaimedLogo = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b35';
      const image = Buffer.from(PNG);
      const avatarImage = { owner: avatar, uploadId: avatarUpload, candidateId: avatarCandidate };
      const logoImage = { owner: logo, uploadId: logoUpload, candidateId: logoCandidate };
      const work = { leaseId: ATTACHMENT, generation: 1 };
      const profileStageKey = `profile-media/staging/${avatarUpload}`;
      const avatarKey = `profile-media/candidate/${avatarCandidate}`;
      const logoKey = `profile-media/candidate/${logoCandidate}`;
      const unclaimedKey = `profile-media/candidate/${unclaimedLogo}`;
      const avatarProof = `attachment-restore-pins/${avatarKey}`;
      const logoProof = `attachment-restore-pins/${logoKey}`;

      const afterStagingHead = (
        key: string,
        writeNextVersion: () => Promise<unknown>,
      ): S3ClientConfig => ({
        ...configuration,
        requestHandler: {
          async handle(
            request: { readonly method: string; readonly path: string },
            options?: { readonly abortSignal?: AbortSignal },
          ) {
            const result = await s3.config.requestHandler.handle(request, options);
            if (request.method === 'HEAD' && request.path.endsWith(`/${key}`)) {
              await writeNextVersion();
            }
            return result;
          },
        },
      });
      const copiedKey = `org/${ORGANIZATION}/019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b36`;
      const firstContents = Buffer.from('Version 1');
      const nextContents = Buffer.from('Version 2');
      const writeStagingVersion = (body: Buffer) =>
        s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: STAGING,
            Body: body,
            ContentType: 'text/plain',
          }),
        );
      const observed = await writeStagingVersion(firstContents);
      expect(observed.VersionId).toBeTruthy();
      const delayed = afterStagingHead(STAGING, () => writeStagingVersion(nextContents));
      const delayedStore = new S3AttachmentObjectStore(BUCKET, delayed, endpoint, true);
      try {
        expect(
          await delayedStore.copyAndVerify({
            stagingKey: STAGING,
            candidateKey: copiedKey,
            sizeBytes: firstContents.byteLength,
          }),
        ).toMatchObject({ verifiedContentType: 'text/plain' });
        const copied = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: copiedKey }));
        expect(await copied.Body?.transformToString()).toBe(firstContents.toString());
      } finally {
        delayedStore.onModuleDestroy();
      }

      const snapshotUpload = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b37';
      const snapshotKey = `profile-media/staging/${snapshotUpload}`;
      const writeSnapshot = (body: Uint8Array) =>
        s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: snapshotKey,
            Body: body,
            ContentLength: body.byteLength,
            ContentType: 'image/png',
          }),
        );
      expect((await writeSnapshot(PNG)).VersionId).toBeTruthy();
      const delayedProfiles = new S3ProfileMediaObjects(
        BUCKET,
        afterStagingHead(snapshotKey, () => writeSnapshot(PNG.slice(0, -1))),
        endpoint,
        true,
      );
      try {
        const source = await delayedProfiles.readSource({
          owner: avatar,
          uploadId: snapshotUpload,
          sizeBytes: PNG.length,
          contentType: 'image/png',
        });
        expect(source).toEqual(image);
      } finally {
        delayedProfiles.onModuleDestroy();
      }
      await profiles.erase({
        ...work,
        owner: avatar,
        uploadId: snapshotUpload,
        objectId: snapshotUpload,
        retention: 'transient',
      });

      const avatarTransfer = await profiles.sign({
        ...avatarImage,
        contentType: 'image/png',
        sizeBytes: PNG.length,
        expiresAt: new Date(Math.floor(Date.now() / 1_000) * 1_000 + 60_000),
      });
      expect((await upload(avatarTransfer, PNG)).status).toBe(204);
      expect((await upload(avatarTransfer, PNG)).status).toBe(204);
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: profileStageKey }));
      expect((await listVersions(profileStageKey)).Versions).toHaveLength(2);
      const inventory = await profiles.listProfileMediaObjects(null, AbortSignal.timeout(10_000));
      expect(inventory.objects).toEqual([{ role: 'staging', objectId: avatarUpload }]);
      await profiles.erase({
        ...work,
        ...avatarImage,
        objectId: avatarUpload,
        retention: 'transient',
      });
      expect((await listVersions(profileStageKey)).Versions ?? []).toEqual([]);
      expect((await listVersions(profileStageKey)).DeleteMarkers ?? []).toEqual([]);

      await profiles.putCandidate({ ...avatarImage, png: image });
      await profiles.pinCandidateForRestore(avatarImage);
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: avatarProof }));
      const avatarVersion = (await listVersions(avatarKey)).Versions?.[0]?.VersionId;
      expect(avatarVersion).toBeTruthy();
      await profiles.erase({
        ...work,
        ...avatarImage,
        objectId: avatarCandidate,
        retention: 'candidate',
      });
      const retainedAvatar = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: avatarKey, VersionId: avatarVersion }),
      );
      expect(await retainedAvatar.Body?.transformToByteArray()).toEqual(PNG);
      expect((await listVersions(avatarKey)).DeleteMarkers).toHaveLength(1);

      await profiles.putCandidate({ ...logoImage, png: image });
      await profiles.pinCandidateForRestore(logoImage);
      await profiles.erase({
        ...work,
        ...logoImage,
        objectId: logoCandidate,
        retention: 'transient',
      });
      expect((await listVersions(logoKey)).Versions ?? []).toEqual([]);
      expect((await listVersions(logoProof)).Versions ?? []).toEqual([]);

      // Model a pin request that reached the bucket after the cleanup lease settled.
      await profiles.pinCandidateForRestore(logoImage);
      const historyPage = await profiles.listProfileMediaObjects(null, inventorySignal);
      expect(historyPage.objects).toContainEqual({
        role: 'candidate',
        objectId: avatarCandidate,
        transientOnly: true,
      });
      const proofPage = await profiles.listProfileMediaObjects(historyPage.next, inventorySignal);
      expect(proofPage.objects).toEqual(
        expect.arrayContaining([
          { role: 'candidate', objectId: avatarCandidate, transientOnly: true },
          { role: 'candidate', objectId: logoCandidate, transientOnly: true },
        ]),
      );
      await profiles.erase({
        ...work,
        ...logoImage,
        objectId: logoCandidate,
        retention: 'transient',
      });
      expect((await listVersions(logoProof)).Versions ?? []).toEqual([]);

      await profiles.putCandidate({ ...logoImage, candidateId: unclaimedLogo, png: image });
      await profiles.erase({
        ...work,
        ...logoImage,
        objectId: unclaimedLogo,
        retention: 'candidate',
      });
      expect((await listVersions(unclaimedKey)).Versions ?? []).toEqual([]);
    } finally {
      client?.destroy();
      store?.onModuleDestroy();
      profileStore?.onModuleDestroy();
      docker('rm', '--force', container);
    }
  });
});
