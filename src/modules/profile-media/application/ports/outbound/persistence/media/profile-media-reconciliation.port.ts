import type { ProfileMediaObjectPage } from '../../../../models/media/profile-media-object-page.model.js';
import type { ProfileMediaReconciliationObservation } from '../../../../models/media/profile-media-reconciliation-observation.model.js';
import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';

/** Persists an inventory lease and requeues observations in their exact owner scope. */
export interface ProfileMediaReconciliation {
  // #region Methods
  /** Leases one durable inventory cursor, or returns null while it is owned. */
  acquire(): Promise<{ readonly id: string; readonly continuation: string | null } | null>;

  /** Resolves a bounded page of physical identities to eligible ledger entries. */
  resolve(
    objects: ProfileMediaObjectPage['objects'],
  ): Promise<readonly ProfileMediaReconciliationObservation[]>;

  /** Rechecks and requeues only cleaned objects under the matching owner's lock. */
  requeue(
    owner: ProfileMediaOwnerBinding,
    observations: readonly ProfileMediaReconciliationObservation[],
  ): Promise<number>;

  /** Advances only the current live lease after all owner transactions succeed. */
  advance(id: string, continuation: string | null): Promise<void>;

  /** Releases an incomplete page without advancing its durable position. */
  release(id: string): Promise<void>;
  // #endregion
}
