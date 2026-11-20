import { getOrganizationContext, requireOrganizationId } from '@cadenway/nest-common';

/** Reads the actor and tenant established by the verified internal token. */
export function attachmentCaller(): { readonly organizationId: string; readonly actorId: string } {
  const organizationId = requireOrganizationId();
  const context = getOrganizationContext();
  if (context?.actor.type !== 'user' || context.actor.id === null)
    throw new Error('A verified user context is required for attachment routes.');
  return { organizationId, actorId: context.actor.id };
}
