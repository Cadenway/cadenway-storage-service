import { ProfileMediaError } from '../../errors/media/profile-media.error.js';
import type { ProfileMediaOwnerBinding } from '../../value-objects/media/profile-media-owner-binding.value-object.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Canonicalizes the UUID identifiers used by the published Storage OpenAPI. */
export function profileMediaIdentity(value: string, version7 = false): string {
  const normalized = value.toLowerCase();
  if (!(version7 ? UUID_V7 : UUID).test(normalized)) {
    throw new ProfileMediaError('invalid-identity');
  }
  return normalized;
}

/** Binds the account or organization key from the authorized operation or owner fact. */
export function profileMediaOwner(owner: {
  readonly kind: string;
  readonly id: string;
}): ProfileMediaOwnerBinding {
  if (owner.kind !== 'avatar' && owner.kind !== 'organization-logo') {
    throw new ProfileMediaError('invalid-identity');
  }
  return { kind: owner.kind, id: profileMediaIdentity(owner.id) };
}

/** Compares two previously normalized account or organization identities. */
export function sameProfileMediaOwner(
  left: ProfileMediaOwnerBinding,
  right: ProfileMediaOwnerBinding,
): boolean {
  return left.kind === right.kind && left.id === right.id;
}
