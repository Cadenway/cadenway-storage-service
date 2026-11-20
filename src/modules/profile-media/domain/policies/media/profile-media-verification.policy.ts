import { ProfileMediaError } from '../../errors/media/profile-media.error.js';
import type { ProfileMediaDerivative } from '../../value-objects/media/profile-media-derivative.value-object.js';
import type { ProfileMediaTransfer } from '../../value-objects/media/profile-media-transfer.value-object.js';
import type { ProfileMediaVerification } from '../../value-objects/media/profile-media-verification.value-object.js';
import { profileMediaIdentity } from './profile-media-identity.policy.js';

/** Inclusive byte limit specified by ProfileMediaSizeBytes in Storage OpenAPI. */
export const MAX_PROFILE_MEDIA_BYTES = 5 * 1024 * 1024;

/** Inclusive maximum pixel width and height of one decoded profile image. */
export const MAX_PROFILE_MEDIA_SOURCE_SIDE = 4_096;

/** Inclusive maximum pixel width and height of the stored PNG derivative. */
export const MAX_PROFILE_MEDIA_DERIVATIVE_SIDE = 512;

/** Minimum pixel width and height of a source avatar. */
export const MIN_AVATAR_SOURCE_SIDE = 256;

const allowedMedia = {
  avatar: ['image/png', 'image/jpeg', 'image/webp'],
  'organization-logo': ['image/png', 'image/svg+xml'],
} satisfies Record<ProfileMediaTransfer['owner']['kind'], readonly string[]>;

function within(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function requireLength(size: number): void {
  if (size > MAX_PROFILE_MEDIA_BYTES) throw new ProfileMediaError('file-too-large');
  if (!within(size, MAX_PROFILE_MEDIA_BYTES)) throw new ProfileMediaError('invalid-image');
}

/** Applies the source encoding and length policy in Storage OpenAPI SignProfileMediaTransfer. */
export function requireProfileMediaDeclaration(
  kind: ProfileMediaTransfer['owner']['kind'],
  contentType: string,
  sizeBytes: number,
): void {
  requireLength(sizeBytes);
  if (!allowedMedia[kind].includes(contentType)) throw new ProfileMediaError('unsupported-type');
}

/** Checks the immutable PNG metadata retained by Storage OpenAPI ProfileMediaPreparation. */
export function checkedProfileMediaDerivative(
  derivative: Omit<ProfileMediaDerivative, 'contentType'> & { readonly contentType: string },
): ProfileMediaDerivative {
  requireLength(derivative.sizeBytes);
  if (
    derivative.contentType !== 'image/png' ||
    !within(derivative.width, MAX_PROFILE_MEDIA_DERIVATIVE_SIDE) ||
    derivative.height !== derivative.width
  ) {
    throw new ProfileMediaError('invalid-image');
  }
  const { contentType, width, height, sizeBytes } = derivative;
  return {
    candidateId: profileMediaIdentity(derivative.candidateId, true),
    contentType,
    width,
    height,
    sizeBytes,
  };
}

/** Validates the matching pinned source and its sanitized candidate per Storage OpenAPI preparation. */
export function verifyProfileMedia(
  transfer: ProfileMediaTransfer,
  proof: ProfileMediaVerification,
): ProfileMediaDerivative {
  const { source, derivative, candidateId } = proof;
  requireProfileMediaDeclaration(transfer.owner.kind, source.contentType, source.sizeBytes);
  if (
    source.contentType !== transfer.contentType ||
    source.sizeBytes !== transfer.sizeBytes ||
    !within(source.width, MAX_PROFILE_MEDIA_SOURCE_SIDE) ||
    source.height !== source.width ||
    source.frames !== 1 ||
    (transfer.owner.kind === 'avatar' && source.width < MIN_AVATAR_SOURCE_SIDE) ||
    (source.contentType === 'image/svg+xml' && source.selfContainedSvg !== true) ||
    !derivative.metadataFree ||
    derivative.width > source.width ||
    derivative.contentType !== 'image/png'
  ) {
    throw new ProfileMediaError('invalid-image');
  }
  return checkedProfileMediaDerivative({ ...derivative, contentType: 'image/png', candidateId });
}
