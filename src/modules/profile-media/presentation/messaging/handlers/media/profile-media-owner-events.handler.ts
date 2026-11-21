import {
  eventSchemas as identitySchemas,
  USER_AVATAR_CHANGED_V1,
  USER_AVATAR_UPLOAD_ABANDONED_V1,
  USER_DELETED_V1,
} from '@cadenway/contracts/events/identity-service';
import {
  eventSchemas as organizationSchemas,
  ORGANIZATION_LOGO_CHANGED_V1,
  ORGANIZATION_LOGO_UPLOAD_ABANDONED_V1,
} from '@cadenway/contracts/events/organization-service';
import { getOrganizationContext, requireOrganizationId } from '@cadenway/nest-common';
import type { EventConsumers, EventContext } from '@cadenway/nest-messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';

import type { AbandonProfileMedia } from '../../../../application/use-cases/commands/media/abandon-profile-media/abandon-profile-media.use-case.js';
import type { ApplyProfileMediaChange } from '../../../../application/use-cases/commands/media/apply-profile-media-change/apply-profile-media-change.use-case.js';
import type { DeleteProfileMediaOwner } from '../../../../application/use-cases/commands/media/delete-profile-media-owner/delete-profile-media-owner.use-case.js';

/** Keeps account decisions in the kit's global deduplication transaction. */
function avatarOwner(organizationId: string | null, userId: string) {
  if (organizationId !== null || getOrganizationContext()?.organizationId !== null) {
    throw new Error('Avatar decisions require an account-scoped delivery.');
  }
  return { kind: 'avatar' as const, id: userId.toLowerCase() };
}

/** Keeps logo decisions in the tenant signed by the authoritative event. */
function logoOwner(organizationId: string) {
  const tenant = requireOrganizationId().toLowerCase();
  if (tenant !== organizationId.toLowerCase()) {
    throw new Error('Logo decisions require their owning organization.');
  }
  return { kind: 'organization-logo' as const, id: tenant };
}

/** Applies a decision inside the active delivery transaction and rolls back a cancelled delivery. */
async function applyDecision(context: EventContext, apply: () => Promise<void>): Promise<void> {
  context.signal.throwIfAborted();
  await apply();
  context.signal.throwIfAborted();
}

/** Applies Identity and Organization facts to their own scoped image references. */
export class ProfileMediaOwnerEventsHandler implements OnApplicationBootstrap {
  // #region Constructor
  /** Binds the durable consumer and the three transaction-owning operations. */
  public constructor(
    private readonly events: Pick<EventConsumers, 'subscribe'>,
    private readonly change: Pick<ApplyProfileMediaChange, 'execute'>,
    private readonly abandon: Pick<AbandonProfileMedia, 'execute'>,
    private readonly remove: Pick<DeleteProfileMediaOwner, 'execute'>,
  ) {}
  // #endregion

  // #region Methods
  /** Replays retained decisions, including earlier changes that retire an individual asset. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.events.subscribe({
      handler: 'apply-avatar-change',
      schemas: identitySchemas,
      event: USER_AVATAR_CHANGED_V1,
      deliverPolicy: 'all',
      handle: (fact, context) =>
        applyDecision(context, async () => {
          const owner = avatarOwner(fact.organizationId, fact.userId);
          if (fact.actor.type !== 'user' || fact.actor.id.toLowerCase() !== owner.id) {
            throw new Error('An avatar change requires the account owner actor.');
          }
          await this.change.execute({
            owner,
            generation: fact.version,
            assetId: fact.assetId,
            oldAssetId: fact.oldAssetId,
          });
        }),
    });
    await this.events.subscribe({
      handler: 'abandon-avatar-upload',
      schemas: identitySchemas,
      event: USER_AVATAR_UPLOAD_ABANDONED_V1,
      deliverPolicy: 'all',
      handle: (fact, context) =>
        applyDecision(context, async () => {
          const owner = avatarOwner(fact.organizationId, fact.userId);
          if (fact.actor.type !== 'system' || fact.actor.id !== 'identity-service') {
            throw new Error('An abandoned avatar requires the Identity system actor.');
          }
          await this.abandon.execute({ owner, uploadId: fact.uploadId });
        }),
    });
    await this.events.subscribe({
      handler: 'delete-avatar-owner',
      schemas: identitySchemas,
      event: USER_DELETED_V1,
      deliverPolicy: 'all',
      handle: (fact, context) =>
        applyDecision(context, async () => {
          const owner = avatarOwner(fact.organizationId, fact.userId);
          if (fact.actor.type !== 'system' || fact.actor.id !== 'identity-service') {
            throw new Error('A deleted account requires the Identity system actor.');
          }
          await this.remove.execute({ owner });
        }),
    });
    await this.events.subscribe({
      handler: 'apply-organization-logo-change',
      schemas: organizationSchemas,
      event: ORGANIZATION_LOGO_CHANGED_V1,
      deliverPolicy: 'all',
      handle: (fact, context) =>
        applyDecision(context, async () => {
          const owner = logoOwner(fact.organizationId);
          if (fact.actor.type !== 'user') {
            throw new Error('A logo change requires the authorized Organization user actor.');
          }
          await this.change.execute({
            owner,
            generation: fact.version,
            assetId: fact.assetId,
            oldAssetId: fact.oldAssetId,
          });
        }),
    });
    await this.events.subscribe({
      handler: 'abandon-organization-logo-upload',
      schemas: organizationSchemas,
      event: ORGANIZATION_LOGO_UPLOAD_ABANDONED_V1,
      deliverPolicy: 'all',
      handle: (fact, context) =>
        applyDecision(context, async () => {
          const owner = logoOwner(fact.organizationId);
          if (fact.actor.type !== 'system' || fact.actor.id !== 'organization-service') {
            throw new Error('An abandoned logo requires the Organization system actor.');
          }
          await this.abandon.execute({ owner, uploadId: fact.uploadId });
        }),
    });
  }
  // #endregion
}
