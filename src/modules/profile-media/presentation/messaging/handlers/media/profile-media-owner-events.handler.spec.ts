import {
  eventSchemas as identitySchemas,
  USER_AVATAR_CHANGED_V1,
  USER_AVATAR_UPLOAD_ABANDONED_V1,
  USER_DELETED_V1,
} from '@cadenway/contracts/events/identity-service';
import type {
  UserAvatarChangedV1,
  UserDeletedV1,
} from '@cadenway/contracts/events/identity-service';
import {
  eventSchemas as organizationSchemas,
  ORGANIZATION_LOGO_CHANGED_V1,
  ORGANIZATION_LOGO_UPLOAD_ABANDONED_V1,
} from '@cadenway/contracts/events/organization-service';
import type { OrganizationLogoUploadAbandonedV1 } from '@cadenway/contracts/events/organization-service';
import { runWithOrganizationContext } from '@cadenway/nest-common';
import type { EventConsumers, EventContext } from '@cadenway/nest-messaging';
import { describe, expect, it, vi } from 'vitest';

import type { AbandonProfileMedia } from '../../../../application/use-cases/commands/media/abandon-profile-media/abandon-profile-media.use-case.js';
import type { ApplyProfileMediaChange } from '../../../../application/use-cases/commands/media/apply-profile-media-change/apply-profile-media-change.use-case.js';
import type { DeleteProfileMediaOwner } from '../../../../application/use-cases/commands/media/delete-profile-media-owner/delete-profile-media-owner.use-case.js';
import { ProfileMediaOwnerEventsHandler } from './profile-media-owner-events.handler.js';

const account = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30';
const organization = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const base = {
  id: '019a7006-2c3d-7e4f-8a5b-6c7d8e9f0a11',
  occurredAt: '2026-11-20T09:05:00Z',
};
const changed: UserAvatarChangedV1 = {
  ...base,
  userId: account,
  actor: { type: 'user', id: account },
  organizationId: null,
  version: 2,
  assetId: '019a7006-2c3d-7e4f-8a5b-6c7d8e9f0a14',
  oldAssetId: '019a7006-2c3d-7e4f-8a5b-6c7d8e9f0a15',
};

async function fixture() {
  const subscribe = vi.fn<EventConsumers['subscribe']>().mockResolvedValue(undefined);
  const change = vi.fn<ApplyProfileMediaChange['execute']>().mockResolvedValue({ applied: true });
  const abandon = vi.fn<AbandonProfileMedia['execute']>().mockResolvedValue({ applied: true });
  const remove = vi.fn<DeleteProfileMediaOwner['execute']>().mockResolvedValue({ applied: true });
  const controller = new AbortController();
  const context: EventContext = {
    signal: controller.signal,
    streamSequence: 1,
    deliveryCount: 1,
    redelivered: false,
    claimVersion: vi.fn<EventContext['claimVersion']>(),
  };
  await new ProfileMediaOwnerEventsHandler(
    { subscribe },
    { execute: change },
    { execute: abandon },
    { execute: remove },
  ).onApplicationBootstrap();
  const subscriptions = subscribe.mock.calls.map(([entry]) => entry);
  const handler = (name: string) => {
    const entry = subscriptions.find(({ handler }) => handler === name);
    if (entry === undefined) throw new Error('Expected a profile media durable.');
    return entry;
  };
  const deliver = (
    name: string,
    fact: UserAvatarChangedV1 | UserDeletedV1 | OrganizationLogoUploadAbandonedV1,
    tenant = fact.organizationId,
  ) =>
    runWithOrganizationContext(
      { organizationId: tenant, actor: fact.actor, scopes: [], role: null },
      () => handler(name).handle(fact, context),
    );
  return { change, abandon, remove, controller, context, subscriptions, deliver };
}

describe(ProfileMediaOwnerEventsHandler.name, () => {
  it('registers only the exact published owner decisions with retained replay', async () => {
    const { subscriptions } = await fixture();
    expect(
      subscriptions.map(({ handler, schemas, event, deliverPolicy }) => [
        handler,
        schemas,
        event,
        deliverPolicy,
      ]),
    ).toEqual([
      ['apply-avatar-change', identitySchemas, USER_AVATAR_CHANGED_V1, 'all'],
      ['abandon-avatar-upload', identitySchemas, USER_AVATAR_UPLOAD_ABANDONED_V1, 'all'],
      ['delete-avatar-owner', identitySchemas, USER_DELETED_V1, 'all'],
      ['apply-organization-logo-change', organizationSchemas, ORGANIZATION_LOGO_CHANGED_V1, 'all'],
      [
        'abandon-organization-logo-upload',
        organizationSchemas,
        ORGANIZATION_LOGO_UPLOAD_ABANDONED_V1,
        'all',
      ],
    ]);
  });

  it('forwards an older change so that its explicitly replaced image is still retired', async () => {
    const { change, deliver, context } = await fixture();
    await deliver('apply-avatar-change', { ...changed, version: 3 });
    await deliver('apply-avatar-change', changed);

    expect(change).toHaveBeenLastCalledWith({
      owner: { kind: 'avatar', id: account },
      generation: 2,
      assetId: changed.assetId,
      oldAssetId: changed.oldAssetId,
    });
    expect(context.claimVersion).not.toHaveBeenCalled();
  });

  it('keeps account deletion global and a logo abandonment in its verified tenant', async () => {
    const { abandon, remove, deliver } = await fixture();
    const deleted: UserDeletedV1 = {
      ...base,
      organizationId: null,
      userId: account,
      actor: { type: 'system', id: 'identity-service' },
      version: 3,
    };
    const abandoned: OrganizationLogoUploadAbandonedV1 = {
      ...base,
      organizationId: organization,
      actor: { type: 'system', id: 'organization-service' },
      version: 1,
      uploadId: '019a7006-2c3d-7e4f-8a5b-6c7d8e9f0a16',
    };
    await deliver('delete-avatar-owner', deleted);
    await deliver('abandon-organization-logo-upload', abandoned, organization.toUpperCase());
    expect(remove).toHaveBeenCalledExactlyOnceWith({ owner: { kind: 'avatar', id: account } });
    expect(abandon).toHaveBeenCalledExactlyOnceWith({
      owner: { kind: 'organization-logo', id: organization },
      uploadId: abandoned.uploadId,
    });
  });

  it('refuses mismatched account actors and tenant-scoped avatar decisions before writing', async () => {
    const { change, deliver } = await fixture();
    await expect(
      deliver('apply-avatar-change', { ...changed, actor: { type: 'user', id: organization } }),
    ).rejects.toThrow('account owner actor');
    await expect(deliver('apply-avatar-change', changed, organization)).rejects.toThrow(
      'account-scoped',
    );
    expect(change).not.toHaveBeenCalled();
  });

  it('rejects a cancelled delivery after the nested operation returns', async () => {
    const { change, controller, deliver } = await fixture();
    change.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({ applied: true });
    });
    await expect(deliver('apply-avatar-change', changed)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
