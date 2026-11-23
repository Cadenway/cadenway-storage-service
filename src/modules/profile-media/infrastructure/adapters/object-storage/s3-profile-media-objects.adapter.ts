import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type GetObjectCommandOutput,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { addAbortSignal, Readable } from 'node:stream';

import {
  eraseS3ObjectVersions,
  hasS3ObjectHistory,
  immutableS3VersionId,
  restoreProofKey,
} from '../../../../../infrastructure/object-storage/s3-object-versions.js';
import type { UploadTransferTicket } from '../../../../../infrastructure/object-storage/upload-transfer-ticket.js';
import type { ProfileMediaCapability } from '../../../application/models/media/profile-media-capability.model.js';
import type { ProfileMediaCleanupLease } from '../../../application/models/media/profile-media-cleanup-lease.model.js';
import type { ProfileMediaObjectPage } from '../../../application/models/media/profile-media-object-page.model.js';
import type { ProfileMediaEraser } from '../../../application/ports/outbound/object-storage/media/profile-media-eraser.port.js';
import type { ProfileMediaObjectInventory } from '../../../application/ports/outbound/object-storage/media/profile-media-object-inventory.port.js';
import {
  ProfileMediaUnavailable,
  type ProfileMediaObjects,
} from '../../../application/ports/outbound/object-storage/media/profile-media-objects.port.js';
import { ProfileMediaError } from '../../../domain/errors/media/profile-media.error.js';
import {
  profileMediaIdentity,
  profileMediaOwner,
} from '../../../domain/policies/media/profile-media-identity.policy.js';
import {
  MAX_PROFILE_MEDIA_BYTES,
  requireProfileMediaDeclaration,
} from '../../../domain/policies/media/profile-media-verification.policy.js';

const prefix = 'profile-media/';
const stagingPrefix = `${prefix}staging/`;
const candidatePrefix = `${prefix}candidate/`;
const candidateProofPrefix = restoreProofKey(candidatePrefix);
const objectVersionsCursor = 'profile-versions:';
const candidateProofsCursor = 'candidate-proofs:';
const objectPath =
  /^profile-media\/(?<role>staging|candidate)\/(?<objectId>[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const maxPageSize = 500;
const maxContinuationLength = 8_192;
const maxTransferSeconds = 300;
const deadlineMs = 10_000;
const pngType = 'image/png';
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function stagingKey(uploadId: string): string {
  return stagingPrefix + profileMediaIdentity(uploadId, true);
}

function candidateKey(uploadId: string, candidateId: string): string {
  const canonical = profileMediaIdentity(candidateId, true);
  if (canonical === profileMediaIdentity(uploadId, true)) throw new ProfileMediaUnavailable();
  return candidatePrefix + canonical;
}

function inventoryObjects(
  entries: readonly { Key?: string; IsLatest?: boolean }[],
  source: 'current' | 'history' | 'proof',
): ProfileMediaObjectPage['objects'] {
  const objects = new Map<string, ProfileMediaObjectPage['objects'][number]>();
  for (const { Key: key, IsLatest } of entries) {
    if (key === undefined) continue;
    if (source === 'proof' && !key.startsWith(candidateProofPrefix)) continue;
    const objectKey =
      source === 'proof' ? candidatePrefix + key.slice(candidateProofPrefix.length) : key;
    const groups = objectPath.exec(objectKey)?.groups;
    const role = groups?.role;
    const objectId = groups?.objectId;
    if (objectId === undefined || (role !== 'staging' && role !== 'candidate')) continue;
    const transientOnly =
      role === 'candidate' && (source === 'proof' || (source === 'history' && IsLatest !== true));
    if (!transientOnly || !objects.has(objectKey)) {
      objects.set(
        objectKey,
        transientOnly ? { role, objectId, transientOnly } : { role, objectId },
      );
    }
  }
  return [...objects.values()];
}

function versionMarkers(continuation: string, keyPrefix: string): [string, string | undefined] {
  const value: unknown = JSON.parse(continuation);
  if (!Array.isArray(value) || value.length !== 2) throw new ProfileMediaUnavailable();
  const key: unknown = value[0];
  const version: unknown = value[1];
  if (
    typeof key !== 'string' ||
    !key.startsWith(keyPrefix) ||
    (version !== null && (typeof version !== 'string' || version === ''))
  ) {
    throw new ProfileMediaUnavailable();
  }
  return [key, version ?? undefined];
}

function deadline(signal?: AbortSignal): AbortSignal {
  const budget = AbortSignal.timeout(deadlineMs);
  return signal === undefined ? budget : AbortSignal.any([signal, budget]);
}

function privateRequest<T>(request: () => Promise<T>): Promise<T> {
  return context.with(suppressTracing(context.active()), request);
}

function missing(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    error.$metadata.httpStatusCode === 404 &&
    error.name !== 'NoSuchBucket'
  );
}

function changed(error: unknown): boolean {
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412;
}

function verifyLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_PROFILE_MEDIA_BYTES) {
    throw new ProfileMediaUnavailable();
  }
}

function signedExpiry(fields: Readonly<Record<string, string>>, limit: number): string {
  if (fields.Policy === undefined) throw new ProfileMediaUnavailable();
  const policy: unknown = JSON.parse(Buffer.from(fields.Policy, 'base64').toString('utf-8'));
  if (
    typeof policy !== 'object' ||
    policy === null ||
    !('expiration' in policy) ||
    typeof policy.expiration !== 'string' ||
    Date.parse(policy.expiration) !== limit ||
    limit <= Date.now()
  ) {
    throw new ProfileMediaUnavailable();
  }
  return new Date(limit).toISOString();
}

async function boundedBody(
  object: GetObjectCommandOutput,
  size: number,
  contentType: string,
  signal: AbortSignal,
  etag?: string,
): Promise<Buffer> {
  const body = object.Body;
  if (!(body instanceof Readable)) throw new ProfileMediaUnavailable();
  try {
    if (
      object.$metadata.httpStatusCode !== 206 ||
      object.ContentType !== contentType ||
      (object.ContentEncoding !== undefined && object.ContentEncoding !== 'identity') ||
      object.ContentRange !== `bytes 0-${String(size - 1)}/${String(size)}` ||
      (object.ContentLength !== undefined && object.ContentLength !== size) ||
      (etag !== undefined && object.ETag !== etag)
    ) {
      throw new ProfileMediaUnavailable();
    }
    // Limit the retained bytes even when the object provider sends a chunked response.
    const bytes = Buffer.allocUnsafe(size + 1);
    let offset = 0;
    for await (const chunk of addAbortSignal(signal, body) as AsyncIterable<unknown>) {
      if (!(chunk instanceof Uint8Array) || chunk.length > bytes.length - offset) {
        throw new ProfileMediaUnavailable();
      }
      bytes.set(chunk, offset);
      offset += chunk.length;
      if (offset > size) throw new ProfileMediaUnavailable();
    }
    if (offset !== size) throw new ProfileMediaUnavailable();
    return bytes.subarray(0, size);
  } finally {
    body.destroy();
  }
}

/** Keeps profile transfers in a private object namespace distinct from task attachments. */
export class S3ProfileMediaObjects
  implements ProfileMediaObjects, ProfileMediaEraser, ProfileMediaObjectInventory
{
  // #region Properties
  /** Preserve every candidate registered before version-aware cleanup is enabled. */
  public get candidateRetention(): ProfileMediaObjects['candidateRetention'] {
    return this.eraseTransientVersions ? 'candidate' : 'preserve';
  }

  /** Enables the local one-shot transfer admission policy. */
  public get oneShotUploads(): boolean {
    return this.transferTickets !== undefined;
  }

  /** Internal endpoint used for conditional reads, writes and cleanup. */
  private readonly storage: S3Client;

  /** Browser endpoint used only for staged multipart policies. */
  private readonly browser: S3Client;
  // #endregion

  // #region Constructor
  /** Uses the service's validated S3 configuration without region redirects or implicit retries. */
  public constructor(
    private readonly bucket: string,
    configuration: S3ClientConfig,
    publicEndpoint: string,
    private readonly eraseTransientVersions = false,
    private readonly transferTickets?: UploadTransferTicket,
  ) {
    const options: S3ClientConfig = {
      ...configuration,
      followRegionRedirects: false,
      // The ledger assigns one unique candidate key per attempt. Preserve a single write even
      // on providers where conditional PUT is unavailable.
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
    this.storage = new S3Client(options);
    this.browser = new S3Client({ ...options, endpoint: publicEndpoint });
  }
  // #endregion

  // #region Methods
  /** Signs exactly the reserved MIME, opaque key and whole-second owner deadline. */
  public async sign(
    input: Parameters<ProfileMediaObjects['sign']>[0],
    signal?: AbortSignal,
  ): Promise<ProfileMediaCapability> {
    signal?.throwIfAborted();
    const owner = profileMediaOwner(input.owner);
    requireProfileMediaDeclaration(owner.kind, input.contentType, input.sizeBytes);
    const key = stagingKey(input.uploadId);
    const limit = input.expiresAt.getTime();
    const seconds = (limit - Math.floor(Date.now() / 1_000) * 1_000) / 1_000;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > maxTransferSeconds) {
      throw new ProfileMediaUnavailable();
    }
    try {
      if (this.transferTickets !== undefined) {
        const uploadId = profileMediaIdentity(input.uploadId, true);
        if (!this.transferTickets.acceptsProfileUploadId(uploadId)) {
          throw new ProfileMediaUnavailable();
        }
        return {
          uploadId,
          ...this.transferTickets.issue({
            key,
            sizeBytes: input.sizeBytes,
            contentType: input.contentType,
            expiresAt: input.expiresAt.toISOString(),
          }),
        };
      }
      const { url, fields } = await privateRequest(() =>
        createPresignedPost(this.browser, {
          Bucket: this.bucket,
          Key: key,
          Fields: { 'Content-Type': input.contentType },
          Conditions: [['content-length-range', 1, input.sizeBytes]],
          Expires: seconds,
        }),
      );
      signal?.throwIfAborted();
      return {
        uploadId: profileMediaIdentity(input.uploadId, true),
        method: 'POST',
        url,
        fields,
        expiresAt: signedExpiry(fields, limit),
      };
    } catch {
      signal?.throwIfAborted();
      throw new ProfileMediaUnavailable();
    }
  }

  /** Records restore evidence before a candidate can be elected in PostgreSQL. */
  public async pinCandidateForRestore(
    input: Parameters<ProfileMediaObjects['pinCandidateForRestore']>[0],
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!this.eraseTransientVersions) return;
    profileMediaOwner(input.owner);
    const key = restoreProofKey(candidateKey(input.uploadId, input.candidateId));
    try {
      await privateRequest(() =>
        this.storage.send(
          new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: '', IfNoneMatch: '*' }),
          { abortSignal: deadline(signal) },
        ),
      );
    } catch (error) {
      if (!changed(error)) {
        signal?.throwIfAborted();
        throw new ProfileMediaUnavailable();
      }
    }
    signal?.throwIfAborted();
  }

  /** Binds a bounded read to the inspected ETag and, when supported, its exact version. */
  public async readSource(
    input: Parameters<ProfileMediaObjects['readSource']>[0],
    signal?: AbortSignal,
  ): Promise<Buffer | null> {
    signal?.throwIfAborted();
    const owner = profileMediaOwner(input.owner);
    requireProfileMediaDeclaration(owner.kind, input.contentType, input.sizeBytes);
    const key = stagingKey(input.uploadId);
    const budget = deadline(signal);
    try {
      const observed = await privateRequest(() =>
        this.storage.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), {
          abortSignal: budget,
        }),
      );
      const { ContentLength: length, ContentType: contentType, ETag: etag } = observed;
      if (
        length === undefined ||
        !Number.isSafeInteger(length) ||
        contentType === undefined ||
        etag === undefined ||
        !/^"[!#-~]{1,256}"$/u.test(etag)
      ) {
        throw new ProfileMediaUnavailable();
      }
      if (length > MAX_PROFILE_MEDIA_BYTES) throw new ProfileMediaError('file-too-large');
      if (length !== input.sizeBytes || contentType !== input.contentType) {
        throw new ProfileMediaError('invalid-image');
      }
      const versionId = this.eraseTransientVersions
        ? immutableS3VersionId(observed.VersionId)
        : undefined;
      return await this.read(key, length, contentType, budget, { etag, versionId });
    } catch (error) {
      signal?.throwIfAborted();
      if (missing(error) || changed(error)) return null;
      if (error instanceof ProfileMediaError) throw error;
      throw new ProfileMediaUnavailable();
    }
  }

  /** Writes a disposable candidate once, with a fixed PNG type and private caching rules. */
  public async putCandidate(
    input: Parameters<ProfileMediaObjects['putCandidate']>[0],
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    profileMediaOwner(input.owner);
    verifyLength(input.png.byteLength);
    if (!input.png.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new ProfileMediaUnavailable();
    }
    const key = candidateKey(input.uploadId, input.candidateId);
    try {
      await privateRequest(() =>
        this.storage.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: input.png,
            ContentLength: input.png.byteLength,
            ContentType: pngType,
            CacheControl: 'private, no-store',
            IfNoneMatch: '*',
          }),
          { abortSignal: deadline(signal) },
        ),
      );
      signal?.throwIfAborted();
    } catch {
      signal?.throwIfAborted();
      throw new ProfileMediaUnavailable();
    }
  }

  /** Reads the bounded PNG at the elected immutable key and returns binary data only. */
  public async readCandidate(
    input: Parameters<ProfileMediaObjects['readCandidate']>[0],
    signal?: AbortSignal,
  ): Promise<Buffer | null> {
    signal?.throwIfAborted();
    profileMediaOwner(input.owner);
    verifyLength(input.sizeBytes);
    const key = candidateKey(input.uploadId, input.candidateId);
    try {
      const bytes = await this.read(key, input.sizeBytes, pngType, deadline(signal));
      if (!bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
        throw new ProfileMediaUnavailable();
      }
      return bytes;
    } catch (error) {
      signal?.throwIfAborted();
      if (missing(error)) return null;
      throw new ProfileMediaUnavailable();
    }
  }

  /** Deletes only the physical key derived from a durable staging or candidate lease. */
  public async erase(lease: ProfileMediaCleanupLease, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    profileMediaOwner(lease.owner);
    const uploadId = profileMediaIdentity(lease.uploadId, true);
    const objectId = profileMediaIdentity(lease.objectId, true);
    const staging = objectId === uploadId;
    const key = staging ? stagingKey(uploadId) : candidateKey(uploadId, objectId);
    const budget = deadline(signal);
    try {
      await privateRequest(async () => {
        if (this.eraseTransientVersions && (staging || lease.retention !== 'preserve')) {
          const proof = restoreProofKey(key);
          const retain =
            !staging &&
            lease.retention === 'candidate' &&
            (await hasS3ObjectHistory(this.storage, this.bucket, proof, budget));
          if (!retain) {
            await eraseS3ObjectVersions(this.storage, this.bucket, key, budget);
            if (!staging && lease.retention === 'transient') {
              await eraseS3ObjectVersions(this.storage, this.bucket, proof, budget);
            }
            return;
          }
        }
        await this.storage.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
          abortSignal: budget,
        });
      });
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      if (!missing(error)) throw new ProfileMediaUnavailable();
    }
  }

  /** Returns opaque records for bounded ledger reconciliation without emitting the bucket cursor. */
  public async listProfileMediaObjects(
    continuation: string | null,
    signal: AbortSignal,
  ): Promise<ProfileMediaObjectPage> {
    signal.throwIfAborted();
    if (
      continuation !== null &&
      (continuation === '' || continuation.length > maxContinuationLength)
    ) {
      throw new ProfileMediaUnavailable();
    }
    try {
      const budget = deadline(signal);
      const cursor = continuation ?? '';
      const page = await privateRequest(() => this.listInventory(cursor, budget));
      if (
        page.next !== null &&
        (page.next.length > maxContinuationLength || page.next === continuation)
      ) {
        throw new ProfileMediaUnavailable();
      }
      signal.throwIfAborted();
      return page;
    } catch {
      signal.throwIfAborted();
      throw new ProfileMediaUnavailable();
    }
  }

  private listInventory(cursor: string, signal: AbortSignal): Promise<ProfileMediaObjectPage> {
    if (this.eraseTransientVersions) return this.listInventoryVersions(cursor, signal);
    const versionedCursor =
      cursor.startsWith(objectVersionsCursor) || cursor.startsWith(candidateProofsCursor);
    return this.listCurrentObjects(versionedCursor ? '' : cursor, signal);
  }

  /** Finds legacy staging history and proofs that appeared after a discarded candidate was cleaned. */
  private async listInventoryVersions(
    cursor: string,
    signal: AbortSignal,
  ): Promise<ProfileMediaObjectPage> {
    const proofOnly = cursor.startsWith(candidateProofsCursor);
    const cursorPrefix = proofOnly ? candidateProofsCursor : objectVersionsCursor;
    const keyPrefix = proofOnly ? candidateProofPrefix : prefix;
    const marker = cursor.startsWith(cursorPrefix) ? cursor.slice(cursorPrefix.length) : '';
    const [keyMarker, versionIdMarker] = marker === '' ? [] : versionMarkers(marker, keyPrefix);
    const result = await this.storage.send(
      new ListObjectVersionsCommand({
        Bucket: this.bucket,
        Prefix: keyPrefix,
        MaxKeys: maxPageSize,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
      { abortSignal: signal },
    );
    const entries = [
      ...(result.Versions ?? []),
      ...(result.DeleteMarkers ?? []).map(({ Key }) => ({ Key })),
    ];
    if (
      typeof result.IsTruncated !== 'boolean' ||
      entries.length > maxPageSize ||
      (result.IsTruncated && !result.NextKeyMarker?.startsWith(keyPrefix))
    ) {
      throw new ProfileMediaUnavailable();
    }
    const next = result.IsTruncated
      ? cursorPrefix + JSON.stringify([result.NextKeyMarker, result.NextVersionIdMarker ?? null])
      : proofOnly
        ? null
        : candidateProofsCursor;
    return { objects: inventoryObjects(entries, proofOnly ? 'proof' : 'history'), next };
  }

  private async listCurrentObjects(
    cursor: string,
    signal: AbortSignal,
  ): Promise<ProfileMediaObjectPage> {
    const result = await this.storage.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: maxPageSize,
        ContinuationToken: cursor || undefined,
      }),
      { abortSignal: signal },
    );
    const entries = result.Contents ?? [];
    if (typeof result.IsTruncated !== 'boolean' || entries.length > maxPageSize) {
      throw new ProfileMediaUnavailable();
    }
    let next: string | null = null;
    if (result.IsTruncated) {
      const token = result.NextContinuationToken;
      if (!token || token === cursor) throw new ProfileMediaUnavailable();
      next = token;
    }
    return { objects: inventoryObjects(entries, 'current'), next };
  }

  /** Closes both trusted endpoint clients on service shutdown. */
  public onModuleDestroy(): void {
    this.storage.destroy();
    this.browser.destroy();
  }

  /** Requests one extra sentinel byte and refuses ignored ranges or changed generations. */
  private async read(
    key: string,
    size: number,
    contentType: string,
    signal: AbortSignal,
    observed?: { readonly etag: string; readonly versionId: string | undefined },
  ): Promise<Buffer> {
    const result = await privateRequest(() =>
      this.storage.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: `bytes=0-${String(size)}`,
          IfMatch: observed?.etag,
          VersionId: observed?.versionId,
        }),
        { abortSignal: signal },
      ),
    );
    return boundedBody(result, size, contentType, signal, observed?.etag);
  }
  // #endregion
}
