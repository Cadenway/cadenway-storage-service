import { ProfileMediaError } from '../../errors/media/profile-media.error.js';
import {
  profileMediaIdentity,
  profileMediaOwner,
} from '../../policies/media/profile-media-identity.policy.js';
import type { ProfileMediaOwnerBinding } from '../../value-objects/media/profile-media-owner-binding.value-object.js';
import type { ProfileMediaOwnerSnapshot } from '../../value-objects/media/profile-media-owner-snapshot.value-object.js';

interface ReferenceChange {
  // #region Properties
  /** Image generation and immutable identifiers from the authoritative AsyncAPI fact. */
  readonly generation: number;
  readonly assetId: string | null;
  readonly oldAssetId: string | null;
  // #endregion
}

interface OwnerDecision {
  // #region Properties
  /** Resulting watermark or deletion fence for the owner. */
  readonly owner: ProfileMediaOwner;

  /** Prepared candidate to attach, and fenced assets to reclaim in the same transaction. */
  readonly adoptAssetId: string | null;
  readonly retireAssetIds: readonly string[];
  // #endregion
}

function canonicalAssetId(assetId: string | null): string | null {
  return assetId === null ? null : profileMediaIdentity(assetId, true);
}

function retireExcept(active: string | null, ...assetIds: readonly (string | null)[]): string[] {
  return [...new Set(assetIds.filter((id): id is string => id !== null && id !== active))];
}

/** Applies authoritative avatar and logo reference changes in generation order. */
export class ProfileMediaOwner {
  // #region Constructor
  /** Stores a validated watermark and immutable owner ID. */
  private constructor(private readonly state: ProfileMediaOwnerSnapshot) {}
  // #endregion

  // #region Properties
  /** Returns detached state for the owner transaction and reconciliation jobs. */
  public get snapshot(): ProfileMediaOwnerSnapshot {
    return { ...this.state, owner: { ...this.state.owner } };
  }
  // #endregion

  // #region Methods
  /** Starts an owner without a projected reference, before any owner fact has arrived. */
  public static empty(owner: ProfileMediaOwnerBinding): ProfileMediaOwner {
    return ProfileMediaOwner.restore({ owner, generation: 0, assetId: null, deleted: false });
  }

  /** Restores the highest known generation and validates the terminal deletion fence. */
  public static restore(snapshot: ProfileMediaOwnerSnapshot): ProfileMediaOwner {
    const { generation, deleted } = snapshot;
    const assetId = canonicalAssetId(snapshot.assetId);
    if (
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      (assetId !== null && (deleted || generation === 0))
    ) {
      throw new ProfileMediaError('invalid-state');
    }
    return new ProfileMediaOwner({
      owner: profileMediaOwner(snapshot.owner),
      generation,
      assetId,
      deleted,
    });
  }

  /** Project a newer reference and honor explicit retirements even from older owner facts. */
  public change(input: ReferenceChange): OwnerDecision {
    const { generation } = input;
    const assetId = canonicalAssetId(input.assetId);
    const oldAssetId = canonicalAssetId(input.oldAssetId);
    const { generation: previousGeneration, assetId: active, deleted } = this.state;
    if (!Number.isSafeInteger(generation) || generation < 1 || assetId === oldAssetId) {
      throw new ProfileMediaError('invalid-state');
    }
    if (deleted || generation < previousGeneration) {
      return {
        owner: this,
        adoptAssetId: null,
        retireAssetIds: retireExcept(active, oldAssetId, assetId),
      };
    }
    if (generation === previousGeneration) {
      if (active !== assetId) throw new ProfileMediaError('invalid-state');
      return { owner: this, adoptAssetId: null, retireAssetIds: retireExcept(active, oldAssetId) };
    }
    return {
      owner: ProfileMediaOwner.restore({ ...this.state, generation, assetId }),
      adoptAssetId: assetId,
      retireAssetIds: retireExcept(assetId, active, oldAssetId),
    };
  }

  /** Records the irreversible user.deleted.v1 fence so later facts cannot reactivate an avatar. */
  public remove(): OwnerDecision {
    if (this.state.deleted) return { owner: this, adoptAssetId: null, retireAssetIds: [] };
    return {
      owner: ProfileMediaOwner.restore({ ...this.state, deleted: true, assetId: null }),
      adoptAssetId: null,
      retireAssetIds: retireExcept(null, this.state.assetId),
    };
  }
  // #endregion
}
