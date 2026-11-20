import { AttachmentError } from '../../errors/attachment/attachment.error.js';
import type { AttachmentVerification } from '../../value-objects/attachment/attachment-verification.value-object.js';

/** Inclusive per-file limit in the attachment mockup (App.dc.html:4993). */
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

const MEDIA_TYPE = /^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+\/[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/u;

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

/** Enforces AttachmentFileName, AttachmentContentType and the signed POST byte limit. */
export function checkedAttachmentMediaType(
  fileName: string,
  declaredType: string,
  sizeBytes: number,
): string {
  const basename = fileName.trim();
  if (
    basename === '' ||
    basename === '.' ||
    basename === '..' ||
    Array.from(fileName).length > 255 ||
    /[\\/\p{Cc}\p{Cs}]/u.test(fileName)
  ) {
    throw new AttachmentError('invalid-file-name');
  }
  const contentType = normalizedMediaType(declaredType);
  if (contentType === null) throw new AttachmentError('invalid-content-type');

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) throw new AttachmentError('invalid-size');
  if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) throw new AttachmentError('file-too-large');
  return contentType;
}

/** Enforces the Storage upload policy's extension-derived media type before signing. */
export function requireAttachmentExtensionMediaType(
  expected: string | null,
  contentType: string,
): void {
  if (normalizedMediaType(expected) !== contentType) {
    throw new AttachmentError('upload-metadata-mismatch');
  }
}

/** Checks UploadContentRefused's byte limit and matches the same immutable copy to its reservation. */
export function requireAttachmentVerification(
  verification: AttachmentVerification,
  contentType: string,
  sizeBytes: number,
): void {
  if (verification.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new AttachmentError('file-too-large');
  }
  if (
    verification.sizeBytes !== sizeBytes ||
    normalizedMediaType(verification.contentType) !== contentType ||
    normalizedMediaType(verification.verifiedContentType) !== contentType
  ) {
    throw new AttachmentError('upload-metadata-mismatch');
  }
}
