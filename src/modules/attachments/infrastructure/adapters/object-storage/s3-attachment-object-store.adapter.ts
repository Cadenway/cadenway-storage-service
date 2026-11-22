import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { fileTypeFromBuffer } from 'file-type';
import { addAbortSignal, Readable } from 'node:stream';

import {
  eraseS3ObjectVersions,
  hasS3ObjectHistory,
  restoreProofKey,
} from '../../../../../infrastructure/object-storage/s3-object-versions.js';
import type { UploadTransferTicket } from '../../../../../infrastructure/object-storage/upload-transfer-ticket.js';
import type { AttachmentObjectPage } from '../../../application/models/attachment/attachment-object-page.model.js';
import type { AttachmentObjectRetention } from '../../../application/models/attachment/attachment-object-retention.model.js';
import type { UploadCapability } from '../../../application/models/attachment/upload-capability.model.js';
import type { IntakeAttachmentObjectPage } from '../../../application/models/intake-attachment/intake-attachment-object-page.model.js';
import type { AttachmentObjectInventory } from '../../../application/ports/outbound/object-storage/attachment/attachment-object-inventory.port.js';
import {
  AttachmentObjectStorageError,
  type AttachmentObjectStore,
} from '../../../application/ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import type { IntakeAttachmentObjectEraser } from '../../../application/ports/outbound/object-storage/intake-attachment/intake-attachment-object-eraser.port.js';
import type { IntakeAttachmentObjectInventory } from '../../../application/ports/outbound/object-storage/intake-attachment/intake-attachment-object-inventory.port.js';
import type { IntakeAttachmentObjectStore } from '../../../application/ports/outbound/object-storage/intake-attachment/intake-attachment-object-store.port.js';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../../../domain/aggregates/attachment/attachment.aggregate.js';
import type { AttachmentVerification } from '../../../domain/value-objects/attachment/attachment-verification.value-object.js';
import { registeredMediaTypeForExtension } from '../media-types/registered-attachment-media-type.adapter.js';

const CAPABILITY_SECONDS = 5 * 60;
const VERIFICATION_BYTES = 4 * 1024;
const STORAGE_DEADLINE_MS = 10_000;
const ATTACHMENT_OBJECT_PAGE_SIZE = 500;
const MAX_CONTINUATION_LENGTH = 8_192;
const VERSION_CURSOR = 's3-versions:';
const ORGANIZATION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const ORGANIZATION_OBJECT_KEY =
  /^org\/(?<organizationId>[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INTAKE_STAGING_KEY =
  /^intake\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requireObjectKey(key: string): void {
  if (!ORGANIZATION_OBJECT_KEY.test(key)) throw new AttachmentObjectStorageError();
}

function checkedOrganization(organizationId: string): string {
  const id = organizationId.toLowerCase();
  if (!ORGANIZATION_ID.test(id)) throw new AttachmentObjectStorageError();
  return id;
}

function requireIntakeStagingKey(key: string): void {
  if (!INTAKE_STAGING_KEY.test(key)) throw new AttachmentObjectStorageError();
}

interface InventoryKey {
  // #region Properties
  /** Physical object key observed by the provider. */
  readonly objectKey: string;

  /** An observation of history without a live object. */
  readonly transientOnly?: true;
  // #endregion
}

interface InventoryPage {
  // #region Properties
  /** Distinct keys in the bounded provider page. */
  readonly keys: readonly InventoryKey[];

  /** The opaque continuation for this inventory mode. */
  readonly next: string | null;
  // #endregion
}

function versionMarkers(cursor: string, prefix: string): [string, string | undefined] {
  const decoded: unknown = JSON.parse(cursor);
  if (!Array.isArray(decoded) || decoded.length !== 2) throw new AttachmentObjectStorageError();
  const key: unknown = decoded[0];
  const version: unknown = decoded[1];
  if (
    typeof key !== 'string' ||
    !key.startsWith(prefix) ||
    (version !== null && (typeof version !== 'string' || version === ''))
  ) {
    throw new AttachmentObjectStorageError();
  }
  return [key, version ?? undefined];
}

function requireTenantObjectKey(key: string, organizationId: string): void {
  if (ORGANIZATION_OBJECT_KEY.exec(key)?.groups?.organizationId !== organizationId) {
    throw new AttachmentObjectStorageError();
  }
}

function organizationPrefix(key: string): string {
  return key.slice(0, key.lastIndexOf('/'));
}

function missingObject(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    error.$metadata.httpStatusCode === 404 &&
    error.name !== 'NoSuchBucket'
  );
}

function observedSize(head: HeadObjectCommandOutput): number {
  const size = head.ContentLength;
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
    throw new AttachmentObjectStorageError();
  }
  return size;
}

function requireReservedSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new AttachmentObjectStorageError();
  }
}

function objectVersion(head: HeadObjectCommandOutput): string {
  if (head.ETag === undefined || head.ETag.length === 0) {
    throw new AttachmentObjectStorageError();
  }
  return head.ETag;
}

function policyExpiry(fields: Readonly<Record<string, string>>, limit: number): string {
  if (fields.Policy === undefined) throw new AttachmentObjectStorageError();
  const policy: unknown = JSON.parse(Buffer.from(fields.Policy, 'base64').toString('utf8'));
  if (
    typeof policy !== 'object' ||
    policy === null ||
    !('expiration' in policy) ||
    typeof policy.expiration !== 'string'
  ) {
    throw new AttachmentObjectStorageError();
  }
  const expiration = Date.parse(policy.expiration);
  if (!Number.isFinite(expiration) || expiration <= Date.now() || expiration > limit) {
    throw new AttachmentObjectStorageError();
  }
  return new Date(expiration).toISOString();
}

function downloadDisposition(fileName: string): string {
  const basename = fileName.replace(/[\\/\p{Cc}\p{Cs}]/gu, '_');
  const fallback = basename.replace(/[^A-Za-z0-9._ -]/gu, '_');
  const encoded = encodeURIComponent(basename).replace(
    /[!'()*]/gu,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function prefixBytes(
  object: GetObjectCommandOutput,
  size: number,
  length: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const body = object.Body;
  if (!(body instanceof Readable)) throw new AttachmentObjectStorageError();
  try {
    if (
      object.ContentRange !== `bytes 0-${String(length - 1)}/${String(size)}` ||
      object.ContentLength !== length
    ) {
      throw new AttachmentObjectStorageError();
    }
    const prefix = Buffer.alloc(length);
    let offset = 0;
    for await (const chunk of addAbortSignal(signal, body) as AsyncIterable<unknown>) {
      if (!(chunk instanceof Uint8Array) || chunk.length > length - offset) {
        throw new AttachmentObjectStorageError();
      }
      prefix.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== length) throw new AttachmentObjectStorageError();
    return prefix;
  } finally {
    body.destroy();
  }
}

async function detectContentType(
  bytes: Uint8Array,
  contentType: string | null,
  objectSize: number,
): Promise<string | null> {
  try {
    const detected = await fileTypeFromBuffer(bytes);
    if (detected !== undefined) {
      return registeredMediaTypeForExtension(detected.ext) ?? detected.mime;
    }
    if (contentType?.toLowerCase() !== 'text/plain' || bytes.includes(0)) return null;

    // The range can end inside a UTF-8 code point only when the object has more bytes.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
      stream: objectSize > bytes.byteLength,
    });
    return 'text/plain';
  } catch {
    // Keep malformed signatures and invalid UTF-8 prefixes unverified.
    return null;
  }
}

/** Signs browser transfers and verifies server-side copies with one S3-compatible bucket. */
export class S3AttachmentObjectStore
  implements
    AttachmentObjectStore,
    AttachmentObjectInventory,
    IntakeAttachmentObjectStore,
    IntakeAttachmentObjectEraser,
    IntakeAttachmentObjectInventory
{
  // #region Properties
  /** Client for operations on the internal storage endpoint. */
  private readonly storage: S3Client;

  /** Client configured for the browser's signed endpoint. */
  private readonly browser: S3Client;

  /** Enables the local one-shot transfer admission policy. */
  public get oneShotUploads(): boolean {
    return this.transferTickets !== undefined;
  }
  // #endregion

  // #region Constructor
  /** Uses the same bucket and signing configuration for the two trusted endpoints. */
  public constructor(
    private readonly bucket: string,
    configuration: S3ClientConfig,
    publicEndpoint: string,
    private readonly eraseTransientVersions = false,
    private readonly transferTickets?: UploadTransferTicket,
  ) {
    const options: S3ClientConfig = {
      ...configuration,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // A retry after an ambiguous copy could overwrite an already verified candidate.
      maxAttempts: 1,
    };
    this.storage = new S3Client(options);
    this.browser = new S3Client({ ...options, endpoint: publicEndpoint });
  }
  // #endregion

  // #region Methods
  /** Lists the attachment prefix and keeps the provider cursor outside automated HTTP traces. */
  public async listAttachmentObjects(
    continuation: string | null,
    signal: AbortSignal,
  ): Promise<AttachmentObjectPage> {
    const { keys, next } = await this.listObjectPage('org/', continuation, signal);
    const objects = keys.flatMap((entry) => {
      const organizationId = ORGANIZATION_OBJECT_KEY.exec(entry.objectKey)?.groups?.organizationId;
      return organizationId === undefined ? [] : [{ organizationId, ...entry }];
    });
    return { objects, next };
  }

  /** Lists opaque staging keys for reconciliation against the persisted intake reservations. */
  public async listIntakeObjects(
    continuation: string | null,
    signal: AbortSignal,
  ): Promise<IntakeAttachmentObjectPage> {
    const { keys, next } = await this.listObjectPage('intake/', continuation, signal);
    const objects = keys.filter(({ objectKey }) => INTAKE_STAGING_KEY.test(objectKey));
    return { objects, next };
  }

  private async listObjectPage(
    prefix: 'org/' | 'intake/',
    continuation: string | null,
    signal: AbortSignal,
  ): Promise<InventoryPage> {
    signal.throwIfAborted();
    try {
      if (continuation === '' || (continuation?.length ?? 0) > MAX_CONTINUATION_LENGTH) {
        throw new AttachmentObjectStorageError();
      }
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(STORAGE_DEADLINE_MS)]);
      const cursor = continuation ?? '';
      return await context.with(suppressTracing(context.active()), () =>
        this.eraseTransientVersions
          ? this.listVersionPage(prefix, cursor, deadline)
          : this.listCurrentPage(prefix, cursor, deadline),
      );
    } catch {
      signal.throwIfAborted();
      throw new AttachmentObjectStorageError();
    }
  }

  /** Uses an independent cursor so enabling version erasure starts a complete inventory pass. */
  private async listVersionPage(
    prefix: string,
    cursor: string,
    signal: AbortSignal,
  ): Promise<InventoryPage> {
    const [keyMarker, versionIdMarker] = cursor.startsWith(VERSION_CURSOR)
      ? versionMarkers(cursor.slice(VERSION_CURSOR.length), prefix)
      : [];
    const result = await this.storage.send(
      new ListObjectVersionsCommand({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: ATTACHMENT_OBJECT_PAGE_SIZE,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
      { abortSignal: signal },
    );
    const versions = result.Versions ?? [];
    const markers = result.DeleteMarkers ?? [];
    if (
      typeof result.IsTruncated !== 'boolean' ||
      versions.length + markers.length > ATTACHMENT_OBJECT_PAGE_SIZE ||
      (result.IsTruncated && !result.NextKeyMarker?.startsWith(prefix))
    ) {
      throw new AttachmentObjectStorageError();
    }
    const next = result.IsTruncated
      ? VERSION_CURSOR + JSON.stringify([result.NextKeyMarker, result.NextVersionIdMarker ?? null])
      : null;
    if (next !== null && (next === cursor || next.length > MAX_CONTINUATION_LENGTH)) {
      throw new AttachmentObjectStorageError();
    }
    const byKey = new Map<string, InventoryKey>();
    for (const { Key } of markers) {
      if (Key?.startsWith(prefix)) byKey.set(Key, { objectKey: Key, transientOnly: true });
    }
    for (const { Key, IsLatest } of versions) {
      if (!Key?.startsWith(prefix)) continue;
      if (IsLatest === true) byKey.set(Key, { objectKey: Key });
      else if (!byKey.has(Key)) byKey.set(Key, { objectKey: Key, transientOnly: true });
    }
    return { keys: [...byKey.values()], next };
  }

  private async listCurrentPage(
    prefix: string,
    cursor: string,
    signal: AbortSignal,
  ): Promise<InventoryPage> {
    const request = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      MaxKeys: ATTACHMENT_OBJECT_PAGE_SIZE,
      ContinuationToken: cursor.startsWith(VERSION_CURSOR) ? undefined : cursor || undefined,
    });
    const result = await this.storage.send(request, { abortSignal: signal });
    const entries = result.Contents ?? [];
    if (typeof result.IsTruncated !== 'boolean' || entries.length > ATTACHMENT_OBJECT_PAGE_SIZE) {
      throw new AttachmentObjectStorageError();
    }
    const next = result.IsTruncated ? result.NextContinuationToken : null;
    if (
      next === undefined ||
      next === '' ||
      (next !== null && next.length > MAX_CONTINUATION_LENGTH) ||
      (next !== null && next === cursor)
    ) {
      throw new AttachmentObjectStorageError();
    }
    const keys = entries.flatMap(({ Key }) =>
      Key?.startsWith(prefix) ? [{ objectKey: Key }] : [],
    );
    return { keys, next };
  }

  /** Signs an exact staging key and media type with a bounded multipart file size. */
  public async signUpload(
    input: Parameters<AttachmentObjectStore['signUpload']>[0],
  ): Promise<UploadCapability> {
    requireObjectKey(input.stagingKey);
    return this.signStagingUpload(input);
  }

  /** Signs a staging key read from the checked tenant's durable intake reservation. */
  public async signIntakeUpload(
    input: Parameters<IntakeAttachmentObjectStore['signIntakeUpload']>[0],
  ): Promise<UploadCapability> {
    checkedOrganization(input.organizationId);
    requireIntakeStagingKey(input.stagingKey);
    return this.signStagingUpload(input);
  }

  private async signStagingUpload(
    input: Parameters<AttachmentObjectStore['signUpload']>[0],
  ): Promise<UploadCapability> {
    requireReservedSize(input.sizeBytes);
    const limit = input.expiresAt.getTime();
    const now = Date.now();
    const seconds = Math.min(CAPABILITY_SECONDS, Math.floor((limit - now) / 1_000));
    if (!Number.isFinite(seconds) || seconds < 1) throw new AttachmentObjectStorageError();
    try {
      if (this.transferTickets !== undefined) {
        const expiresAt = new Date(Math.floor(now / 1_000) * 1_000 + seconds * 1_000).toISOString();
        return {
          id: input.attachmentId,
          ...this.transferTickets.issue({
            key: input.stagingKey,
            sizeBytes: input.sizeBytes,
            contentType: input.contentType,
            expiresAt,
          }),
        };
      }
      const signed = await createPresignedPost(this.browser, {
        Bucket: this.bucket,
        Key: input.stagingKey,
        Fields: { 'Content-Type': input.contentType },
        Conditions: [['content-length-range', 1, input.sizeBytes]],
        Expires: seconds,
      });
      return {
        id: input.attachmentId,
        method: 'POST',
        url: signed.url,
        fields: signed.fields,
        expiresAt: policyExpiry(signed.fields, limit),
      };
    } catch {
      throw new AttachmentObjectStorageError();
    }
  }

  /** Copies the staged version once and sniffs the eligible candidate, never the mutable source. */
  public async copyAndVerify(
    input: Parameters<AttachmentObjectStore['copyAndVerify']>[0],
  ): Promise<AttachmentVerification | null> {
    const { stagingKey, candidateKey } = input;
    requireObjectKey(stagingKey);
    requireObjectKey(candidateKey);
    if (
      stagingKey === candidateKey ||
      organizationPrefix(stagingKey) !== organizationPrefix(candidateKey)
    ) {
      throw new AttachmentObjectStorageError();
    }
    return this.copyStagingAndVerify(stagingKey, candidateKey, input.sizeBytes);
  }

  /** Copies the bound opaque staging key to an immutable candidate under the explicit tenant. */
  public async copyAndVerifyIntake(
    input: Parameters<IntakeAttachmentObjectStore['copyAndVerifyIntake']>[0],
  ): Promise<AttachmentVerification | null> {
    const { stagingKey, candidateKey } = input;
    const organizationId = checkedOrganization(input.organizationId);
    requireIntakeStagingKey(stagingKey);
    requireTenantObjectKey(candidateKey, organizationId);
    return this.copyStagingAndVerify(stagingKey, candidateKey, input.sizeBytes);
  }

  private async copyStagingAndVerify(
    stagingKey: string,
    candidateKey: string,
    sizeBytes: number,
  ): Promise<AttachmentVerification | null> {
    requireReservedSize(sizeBytes);
    const options = { abortSignal: AbortSignal.timeout(STORAGE_DEADLINE_MS) };
    try {
      const staged = await this.storage.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: stagingKey }),
        options,
      );
      const size = observedSize(staged);
      if (size !== sizeBytes) {
        return {
          sizeBytes: size,
          contentType: staged.ContentType ?? null,
          verifiedContentType: null,
        };
      }
      const copy = await this.storage.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: candidateKey,
          CopySource: `${this.bucket}/${stagingKey}`,
          CopySourceIfMatch: objectVersion(staged),
          IfNoneMatch: '*',
        }),
        options,
      );
      const candidate = await this.storage.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: candidateKey }),
        options,
      );
      const candidateSize = observedSize(candidate);
      const etag = objectVersion(candidate);
      if (etag !== copy.CopyObjectResult?.ETag) throw new AttachmentObjectStorageError();
      const contentType = candidate.ContentType ?? null;
      if (candidateSize !== sizeBytes) {
        return { sizeBytes: candidateSize, contentType, verifiedContentType: null };
      }
      const length = Math.min(candidateSize, VERIFICATION_BYTES);
      const object = await this.storage.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: candidateKey,
          IfMatch: etag,
          Range: `bytes=0-${String(length - 1)}`,
        }),
        options,
      );
      const bytes = await prefixBytes(object, candidateSize, length, options.abortSignal);
      return {
        sizeBytes: candidateSize,
        contentType,
        verifiedContentType: await detectContentType(bytes, contentType, candidateSize),
      };
    } catch (error) {
      if (
        missingObject(error) ||
        (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412)
      ) {
        return null;
      }
      throw new AttachmentObjectStorageError();
    }
  }

  /** Signs a download as an attachment with a safe Unicode filename. */
  public async signDownload(
    input: Parameters<AttachmentObjectStore['signDownload']>[0],
  ): Promise<{ readonly url: string; readonly expiresAt: string }> {
    requireObjectKey(input.objectKey);
    const signingDate = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    try {
      const url = await getSignedUrl(
        this.browser,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: input.objectKey,
          ResponseContentDisposition: downloadDisposition(input.fileName),
          ResponseContentType: 'application/octet-stream',
          ResponseCacheControl: 'private, no-store',
        }),
        { expiresIn: CAPABILITY_SECONDS, signingDate },
      );
      return {
        url,
        expiresAt: new Date(signingDate.getTime() + CAPABILITY_SECONDS * 1_000).toISOString(),
      };
    } catch {
      throw new AttachmentObjectStorageError();
    }
  }

  /** Records monotonic restore evidence outside the PostgreSQL snapshot. */
  public async retainCandidate(candidateKey: string): Promise<void> {
    requireObjectKey(candidateKey);
    try {
      await context.with(suppressTracing(context.active()), () =>
        this.storage.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: restoreProofKey(candidateKey),
            Body: '',
            IfNoneMatch: '*',
          }),
          { abortSignal: AbortSignal.timeout(STORAGE_DEADLINE_MS) },
        ),
      );
    } catch (error) {
      if (!(error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412)) {
        throw new AttachmentObjectStorageError();
      }
    }
  }

  /** Erases a durably fenced storage object with its assigned retention policy. */
  public async deleteObject(
    objectKey: string,
    retention: AttachmentObjectRetention,
  ): Promise<void> {
    requireObjectKey(objectKey);
    return this.eraseObject(objectKey, retention);
  }

  /** Erases an opaque staging object or verified candidate selected by tenant-scoped cleanup. */
  public async deleteIntakeObject(
    input: Parameters<IntakeAttachmentObjectEraser['deleteIntakeObject']>[0],
  ): Promise<void> {
    const organizationId = checkedOrganization(input.organizationId);
    if (!INTAKE_STAGING_KEY.test(input.objectKey)) {
      requireTenantObjectKey(input.objectKey, organizationId);
    }
    return this.eraseObject(input.objectKey, input.retention);
  }

  private async eraseObject(
    objectKey: string,
    retention: AttachmentObjectRetention,
  ): Promise<void> {
    const signal = AbortSignal.timeout(STORAGE_DEADLINE_MS);
    if (this.eraseTransientVersions && retention !== 'preserve') {
      try {
        const retained = await context.with(suppressTracing(context.active()), async () => {
          const proof = restoreProofKey(objectKey);
          if (
            retention === 'candidate' &&
            (await hasS3ObjectHistory(this.storage, this.bucket, proof, signal))
          ) {
            return true;
          }
          await eraseS3ObjectVersions(this.storage, this.bucket, objectKey, signal);
          if (retention === 'transient') {
            await eraseS3ObjectVersions(this.storage, this.bucket, proof, signal);
          }
          return false;
        });
        if (!retained) return;
      } catch {
        throw new AttachmentObjectStorageError();
      }
    }
    try {
      await this.storage.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }), {
        abortSignal: signal,
      });
    } catch (error) {
      if (!missingObject(error)) throw new AttachmentObjectStorageError();
    }
  }

  /** Closes both SDK clients during application shutdown. */
  public onModuleDestroy(): void {
    this.storage.destroy();
    this.browser.destroy();
  }
  // #endregion
}
