import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';
import type { ProfileMediaTransaction } from '../../../../models/media/profile-media-transaction.model.js';

/** Opens or joins the transaction scoped to this account or organization. */
export interface ProfileMediaUnitOfWork {
  // #region Methods
  /** Runs with the exact verified owner and joins any matching event transaction. */
  run<T>(
    owner: ProfileMediaOwnerBinding,
    work: (store: ProfileMediaTransaction) => Promise<T>,
  ): Promise<T>;
  // #endregion
}
