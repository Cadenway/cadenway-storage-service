import type { ProfileMediaObjectPage } from '../../../../models/media/profile-media-object-page.model.js';

/** Lists only the private profile media namespace for the durable cleanup job. */
export interface ProfileMediaObjectInventory {
  // #region Methods
  /** Reads one bounded page using an opaque object storage cursor. */
  listProfileMediaObjects(
    continuation: string | null,
    signal: AbortSignal,
  ): Promise<ProfileMediaObjectPage>;
  // #endregion
}
