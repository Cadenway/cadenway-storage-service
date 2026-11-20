import { EventConsumers } from '@cadenway/nest-messaging';
import type { FactoryProvider } from '@nestjs/common';

import { AbandonProfileMedia } from '../../../../application/use-cases/commands/media/abandon-profile-media/abandon-profile-media.use-case.js';
import { ApplyProfileMediaChange } from '../../../../application/use-cases/commands/media/apply-profile-media-change/apply-profile-media-change.use-case.js';
import { DeleteProfileMediaOwner } from '../../../../application/use-cases/commands/media/delete-profile-media-owner/delete-profile-media-owner.use-case.js';
import { ProfileMediaOwnerEventsHandler } from '../../../../presentation/messaging/handlers/media/profile-media-owner-events.handler.js';

/** Registers only the five owner facts and reuses their transactional consumer scope. */
export const profileMediaEventsProvider: FactoryProvider<ProfileMediaOwnerEventsHandler> = {
  provide: ProfileMediaOwnerEventsHandler,
  inject: [EventConsumers, ApplyProfileMediaChange, AbandonProfileMedia, DeleteProfileMediaOwner],
  useFactory: (
    events: EventConsumers,
    change: ApplyProfileMediaChange,
    abandon: AbandonProfileMedia,
    remove: DeleteProfileMediaOwner,
  ): ProfileMediaOwnerEventsHandler =>
    new ProfileMediaOwnerEventsHandler(events, change, abandon, remove),
};
