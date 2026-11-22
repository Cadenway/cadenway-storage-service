import type { ProfileMediaOwnerBinding } from '../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';
import type { ProfileMediaObjectRetention } from './profile-media-object-retention.model.js';

/** One generation-fenced physical deletion reserved by a cleanup worker. */
export interface ProfileMediaCleanupLease {
  // #region Properties
  /** Owner and upload are retained independently of the private object identity. */
  readonly owner: ProfileMediaOwnerBinding;
  readonly uploadId: string;
  readonly objectId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly retention: ProfileMediaObjectRetention;
  // #endregion
}
