import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
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

import type { AttachmentObjectPage } from '../../../application/models/attachment/attachment-object-page.model.js';
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
  // #endregion

  // #region Constructor
  /** Uses the same bucket and signing configuration for the two trusted endpoints. */
  public constructor(
    private readonly bucket: string,
    configuration: S3ClientConfig,
    publicEndpoint: string,
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
    const objects = keys.flatMap((objectKey) => {
      const organizationId = ORGANIZATION_OBJECT_KEY.exec(objectKey)?.groups?.organizationId;
      return organizationId === undefined ? [] : [{ organizationId, objectKey }];
    });
    return { objects, next };
  }

  /** Lists opaque staging keys for reconciliation against the persisted intake reservations. */
  public async listIntakeObjects(
    continuation: string | null,
    signal: AbortSignal,
  ): Promise<IntakeAttachmentObjectPage> {
    const { keys, next } = await this.listObjectPage('intake/', continuation, signal);
    const objects = keys
      .filter((key) => INTAKE_STAGING_KEY.test(key))
      .map((objectKey) => ({ objectKey }));
    return { objects, next };
  }

  private async listObjectPage(
    prefix: 'org/' | 'intake/',
    continuation: string | null,
    signal: AbortSignal,
  ): Promise<{ readonly keys: readonly string[]; readonly next: string | null }> {
    signal.throwIfAborted();
    try {
      const request = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: ATTACHMENT_OBJECT_PAGE_SIZE,
        ContinuationToken: continuation ?? undefined,
      });
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(STORAGE_DEADLINE_MS)]);
      const result = await context.with(suppressTracing(context.active()), () =>
        this.storage.send(request, { abortSignal: deadline }),
      );
      const entries = result.Contents ?? [];
      if (typeof result.IsTruncated !== 'boolean' || entries.length > ATTACHMENT_OBJECT_PAGE_SIZE) {
        throw new AttachmentObjectStorageError();
      }
      const next = result.IsTruncated ? result.NextContinuationToken : null;
      if (
        next === undefined ||
        next === '' ||
        (next !== null && next.length > MAX_CONTINUATION_LENGTH) ||
        (next !== null && next === continuation)
      ) {
        throw new AttachmentObjectStorageError();
      }
      const keys = entries.flatMap(({ Key }) => (typeof Key === 'string' ? [Key] : []));
      return { keys, next };
    } catch {
      signal.throwIfAborted();
      throw new AttachmentObjectStorageError();
    }
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
    const limit = input.expiresAt.getTime();
    const seconds = Math.min(CAPABILITY_SECONDS, Math.floor((limit - Date.now()) / 1_000));
    if (!Number.isFinite(seconds) || seconds < 1) throw new AttachmentObjectStorageError();
    try {
      const signed = await createPresignedPost(this.browser, {
        Bucket: this.bucket,
        Key: input.stagingKey,
        Fields: { 'Content-Type': input.contentType },
        Conditions: [['content-length-range', 1, MAX_ATTACHMENT_SIZE_BYTES]],
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
    return this.copyStagingAndVerify(stagingKey, candidateKey);
  }

  /** Copies the bound opaque staging key to an immutable candidate under the explicit tenant. */
  public async copyAndVerifyIntake(
    input: Parameters<IntakeAttachmentObjectStore['copyAndVerifyIntake']>[0],
  ): Promise<AttachmentVerification | null> {
    const { stagingKey, candidateKey } = input;
    const organizationId = checkedOrganization(input.organizationId);
    requireIntakeStagingKey(stagingKey);
    requireTenantObjectKey(candidateKey, organizationId);
    return this.copyStagingAndVerify(stagingKey, candidateKey);
  }

  private async copyStagingAndVerify(
    stagingKey: string,
    candidateKey: string,
  ): Promise<AttachmentVerification | null> {
    const options = { abortSignal: AbortSignal.timeout(STORAGE_DEADLINE_MS) };
    try {
      const staged = await this.storage.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: stagingKey }),
        options,
      );
      const size = observedSize(staged);
      if (size === 0 || size > MAX_ATTACHMENT_SIZE_BYTES) {
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
      if (candidateSize === 0 || candidateSize > MAX_ATTACHMENT_SIZE_BYTES) {
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

  /** Erases a storage object, including when a previous cleanup already removed it. */
  public async deleteObject(objectKey: string): Promise<void> {
    requireObjectKey(objectKey);
    return this.eraseObject(objectKey);
  }

  /** Erases an opaque staging object or verified candidate selected by tenant-scoped cleanup. */
  public async deleteIntakeObject(
    input: Parameters<IntakeAttachmentObjectEraser['deleteIntakeObject']>[0],
  ): Promise<void> {
    const organizationId = checkedOrganization(input.organizationId);
    if (!INTAKE_STAGING_KEY.test(input.objectKey)) {
      requireTenantObjectKey(input.objectKey, organizationId);
    }
    return this.eraseObject(input.objectKey);
  }

  private async eraseObject(objectKey: string): Promise<void> {
    try {
      await this.storage.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }), {
        abortSignal: AbortSignal.timeout(STORAGE_DEADLINE_MS),
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
