import { AttachmentError } from '../../errors/attachment/attachment.error.js';
import type { AttachmentFact } from '../../events/attachment/attachment-fact.event.js';
import type { AttachmentReservation } from '../../value-objects/attachment/attachment-reservation.value-object.js';
import type { AttachmentSnapshot } from '../../value-objects/attachment/attachment-snapshot.value-object.js';
import type { AttachmentVerification } from '../../value-objects/attachment/attachment-verification.value-object.js';

/** Inclusive per-file limit in the attachment mockup (App.dc.html:4993). */
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TASK_KEY = /^[A-Z]{2,5}-[1-9][0-9]{0,8}$/u;
const MEDIA_TYPE = /^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+\/[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/u;

interface AttachmentChange {
  // #region Properties
  /** Resulting aggregate, or the original instance for a replay. */
  readonly attachment: Attachment;

  /** Fact to append only when a verified attachment changes. */
  readonly event: AttachmentFact | null;
  // #endregion
}

/** Validates the concrete ASCII tokens from RFC 9110 and the AttachmentContentType contract. */
function normalizedMediaType(value: string | null): string | null {
  if (
    value === null ||
    value.length > 127 ||
    !MEDIA_TYPE.test(value) ||
    value.startsWith('*/') ||
    value.endsWith('/*')
  ) {
    return null;
  }
  return value.toLowerCase();
}

function instant(date: Date): number {
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) throw new AttachmentError('invalid-state');
  return milliseconds;
}

function checkedCopy(snapshot: AttachmentSnapshot): AttachmentSnapshot {
  const id = snapshot.id.toLowerCase();
  const organizationId = snapshot.organizationId.toLowerCase();
  const authorUserId = snapshot.authorUserId.toLowerCase();
  if (
    !UUID_V7.test(id) ||
    !UUID.test(organizationId) ||
    !UUID.test(authorUserId) ||
    !TASK_KEY.test(snapshot.taskKey)
  ) {
    throw new AttachmentError('invalid-identity');
  }

  // The storage upload policy scopes object keys by organization. Staging is the only writable URL.
  const prefix = `org/${organizationId}/`;
  if (
    snapshot.objectKey !== prefix + id ||
    snapshot.stagingObjectKey === snapshot.objectKey ||
    !snapshot.stagingObjectKey.startsWith(prefix) ||
    !UUID_V7.test(snapshot.stagingObjectKey.slice(prefix.length))
  ) {
    throw new AttachmentError('invalid-object-key');
  }

  // AttachmentFileName limits the original basename to 255 Unicode code points.
  const basename = snapshot.fileName.trim();
  if (
    basename === '' ||
    basename === '.' ||
    basename === '..' ||
    Array.from(snapshot.fileName).length > 255 ||
    /[\\/\p{Cc}\p{Cs}]/u.test(snapshot.fileName)
  ) {
    throw new AttachmentError('invalid-file-name');
  }
  const contentType = normalizedMediaType(snapshot.contentType);
  if (contentType === null) throw new AttachmentError('invalid-content-type');

  // The signed POST upload policy requires at least one byte and at most 25 MiB.
  if (!Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes < 1) {
    throw new AttachmentError('invalid-size');
  }
  if (snapshot.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) throw new AttachmentError('file-too-large');

  const reservedAt = instant(snapshot.reservedAt);
  const expiresAt = instant(snapshot.expiresAt);
  const uploadedAt = snapshot.uploadedAt === null ? null : instant(snapshot.uploadedAt);
  const deletedAt = snapshot.deletedAt === null ? null : instant(snapshot.deletedAt);
  if (
    reservedAt >= expiresAt ||
    (uploadedAt !== null && (uploadedAt < reservedAt || uploadedAt >= expiresAt)) ||
    (deletedAt !== null && deletedAt < (uploadedAt ?? reservedAt))
  ) {
    throw new AttachmentError('invalid-state');
  }
  checkLifecycle(snapshot.status, snapshot.version, uploadedAt, deletedAt);

  return {
    id,
    organizationId,
    authorUserId,
    taskKey: snapshot.taskKey,
    objectKey: snapshot.objectKey,
    stagingObjectKey: snapshot.stagingObjectKey,
    fileName: snapshot.fileName,
    contentType,
    sizeBytes: snapshot.sizeBytes,
    status: snapshot.status,
    version: snapshot.version,
    reservedAt: new Date(reservedAt),
    expiresAt: new Date(expiresAt),
    uploadedAt: uploadedAt === null ? null : new Date(uploadedAt),
    deletedAt: deletedAt === null ? null : new Date(deletedAt),
  };
}

function checkLifecycle(
  status: AttachmentSnapshot['status'],
  version: number,
  uploadedAt: number | null,
  deletedAt: number | null,
): void {
  switch (status) {
    case 'pending':
      if (version === 0 && uploadedAt === null && deletedAt === null) return;
      break;
    case 'ready':
      if (version === 1 && uploadedAt !== null && deletedAt === null) return;
      break;
    case 'deleted':
      if (deletedAt !== null && version === (uploadedAt === null ? 1 : 2)) return;
      break;
  }
  throw new AttachmentError('invalid-state');
}

/** Owns one task attachment from signed reservation to verified metadata and durable removal. */
export class Attachment {
  // #region Constructor
  /** Takes a validated and privately owned snapshot. */
  private constructor(private readonly state: AttachmentSnapshot) {}
  // #endregion

  // #region Properties
  /** Produces a detached snapshot so mutable Date values cannot change the aggregate. */
  public get snapshot(): AttachmentSnapshot {
    const { reservedAt, expiresAt, uploadedAt, deletedAt } = this.state;
    return {
      ...this.state,
      reservedAt: new Date(reservedAt),
      expiresAt: new Date(expiresAt),
      uploadedAt: uploadedAt === null ? null : new Date(uploadedAt),
      deletedAt: deletedAt === null ? null : new Date(deletedAt),
    };
  }
  // #endregion

  // #region Methods
  /** Reserves one bounded upload without exposing it as a ready attachment. */
  public static reserve(reservation: AttachmentReservation): Attachment {
    return Attachment.rehydrate({
      ...reservation,
      status: 'pending',
      version: 0,
      uploadedAt: null,
      deletedAt: null,
    });
  }

  /** Restores persisted state without producing a new fact. */
  public static rehydrate(snapshot: AttachmentSnapshot): Attachment {
    return new Attachment(checkedCopy(snapshot));
  }

  /** Enforces the Storage upload policy's extension-derived media type before signing. */
  public requireExtensionMediaType(expected: string | null): void {
    if (normalizedMediaType(expected) !== this.state.contentType) {
      throw new AttachmentError('upload-metadata-mismatch');
    }
  }

  /** Checks the UploadContentRefused byte limit before matching the reserved metadata. */
  public finalize(verification: AttachmentVerification, at: Date): AttachmentChange {
    if (this.state.status === 'ready') return { attachment: this, event: null };
    if (this.state.status === 'deleted') throw new AttachmentError('attachment-deleted');
    if (instant(at) >= instant(this.state.expiresAt)) throw new AttachmentError('upload-expired');
    if (verification.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new AttachmentError('file-too-large');
    }
    if (
      verification.sizeBytes !== this.state.sizeBytes ||
      normalizedMediaType(verification.contentType) !== this.state.contentType ||
      normalizedMediaType(verification.verifiedContentType) !== this.state.contentType
    ) {
      throw new AttachmentError('upload-metadata-mismatch');
    }

    const attachment = Attachment.rehydrate({
      ...this.state,
      status: 'ready',
      version: 1,
      uploadedAt: at,
    });
    return { attachment, event: attachment.fact('file.uploaded.v1', at) };
  }

  /** Removes a ready attachment once, leaving physical object cleanup to its use case. */
  public delete(at: Date): AttachmentChange {
    if (this.state.status === 'deleted') return { attachment: this, event: null };
    if (this.state.status === 'pending') throw new AttachmentError('upload-not-ready');

    const attachment = this.tombstone(at);
    return { attachment, event: attachment.fact('file.deleted.v1', at) };
  }

  /** Discards a pending reservation when its owning task is purged. */
  public discard(at: Date): Attachment {
    if (this.state.status === 'deleted') return this;
    if (this.state.status === 'ready') throw new AttachmentError('invalid-state');
    return this.tombstone(at);
  }

  /** Expiration jobs may discard only pending reservations whose cutoff has passed. */
  public expire(at: Date): Attachment {
    if (this.state.status !== 'pending' || instant(at) < instant(this.state.expiresAt)) return this;
    return this.discard(at);
  }

  /** Prevents future finalization and keeps the object references available for cleanup. */
  private tombstone(at: Date): Attachment {
    return Attachment.rehydrate({
      ...this.state,
      status: 'deleted',
      version: this.state.version + 1,
      deletedAt: at,
    });
  }

  /** Builds the private-data-free fact for an accepted outbox transition. */
  private fact(type: AttachmentFact['type'], occurredAt: Date): AttachmentFact {
    return {
      type,
      occurredAt: occurredAt.toISOString(),
      organizationId: this.state.organizationId,
      fileId: this.state.id,
      taskKey: this.state.taskKey,
      sizeBytes: this.state.sizeBytes,
      version: this.state.version,
    };
  }
  // #endregion
}
