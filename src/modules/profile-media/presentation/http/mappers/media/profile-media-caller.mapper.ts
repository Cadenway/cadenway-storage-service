import { getOrganizationContext, ProblemException } from '@cadenway/nest-common';

import type { PrepareProfileMediaInput } from '../../../../application/use-cases/commands/media/prepare-profile-media/prepare-profile-media.input.js';
import type { ReadProfileMediaInput } from '../../../../application/use-cases/queries/media/read-profile-media/read-profile-media.input.js';

function verifiedUser(): { readonly userId: string; readonly organizationId: string | null } {
  const context = getOrganizationContext();
  if (context?.actor.type !== 'user' || context.actor.id === null) {
    throw new ProblemException({ status: 403, code: 'auth.actor-not-allowed' });
  }
  return {
    userId: context.actor.id.toLowerCase(),
    organizationId: context.organizationId?.toLowerCase() ?? null,
  };
}

/** Derives upload ownership and the uploader from the signed gateway context. */
export function profileMediaUploadCaller(
  kind: PrepareProfileMediaInput['owner']['kind'],
): Pick<PrepareProfileMediaInput, 'owner' | 'uploaderUserId'> {
  const { userId, organizationId } = verifiedUser();
  if (kind === 'avatar') {
    if (organizationId !== null)
      throw new ProblemException({ status: 404, code: 'media.not-found' });
    return { owner: { kind, id: userId }, uploaderUserId: userId };
  }
  if (organizationId === null) {
    throw new ProblemException({ status: 403, code: 'auth.organization-required' });
  }
  return { owner: { kind, id: organizationId }, uploaderUserId: userId };
}

/** Allows an account's own avatar or the directory owner authorized by its current tenant. */
export function profileMediaAvatarOwner(ownerUserId: string): ReadProfileMediaInput['owner'] {
  const { userId, organizationId } = verifiedUser();
  const owner = ownerUserId.toLowerCase();
  if (owner !== userId && organizationId === null) {
    throw new ProblemException({ status: 403, code: 'auth.organization-required' });
  }
  return { kind: 'avatar', id: owner };
}
