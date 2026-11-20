import type { ProfileMediaReconciliationObservation } from '../../../../models/media/profile-media-reconciliation-observation.model.js';
import type { ProfileMediaObjectInventory } from '../../../../ports/outbound/object-storage/media/profile-media-object-inventory.port.js';
import type { ProfileMediaReconciliation } from '../../../../ports/outbound/persistence/media/profile-media-reconciliation.port.js';
import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';

/** Reconciles one bounded physical inventory page through its owner-scoped ledgers. */
export class ReconcileProfileMedia {
  // #region Constructor
  /** Binds the durable reconciliation store and the external inventory. */
  public constructor(
    private readonly store: ProfileMediaReconciliation,
    private readonly inventory: ProfileMediaObjectInventory,
  ) {}
  // #endregion

  // #region Methods
  /** Advances only after all owner rechecks succeed; failed pages can be replayed safely. */
  public async execute(signal: AbortSignal): Promise<number> {
    const cursor = await this.store.acquire();
    if (cursor === null) return 0;
    try {
      const page = await this.inventory.listProfileMediaObjects(cursor.continuation, signal);
      if (page.objects.length > 500)
        throw new RangeError('Profile inventory page exceeds its bound.');
      const observations = await this.store.resolve(page.objects);
      const byOwner = new Map<
        string,
        { owner: ProfileMediaOwnerBinding; objects: ProfileMediaReconciliationObservation[] }
      >();
      for (const observation of observations) {
        const owner = { kind: observation.kind, id: observation.ownerId };
        const key = `${owner.kind}:${owner.id}`;
        const group = byOwner.get(key) ?? { owner, objects: [] };
        group.objects.push(observation);
        byOwner.set(key, group);
      }
      let changed = 0;
      for (const { owner, objects } of byOwner.values()) {
        signal.throwIfAborted();
        changed += await this.store.requeue(owner, objects);
      }
      await this.store.advance(cursor.id, page.next);
      return changed;
    } catch (error) {
      await this.store.release(cursor.id);
      throw error;
    }
  }
  // #endregion
}
