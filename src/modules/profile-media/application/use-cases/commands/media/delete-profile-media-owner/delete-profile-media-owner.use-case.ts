import { ProfileMediaUpload } from '../../../../../domain/aggregates/media/profile-media-upload.aggregate.js';
import type { ProfileMediaUnitOfWork } from '../../../../ports/outbound/transactions/media/profile-media-unit-of-work.port.js';
import type { DeleteProfileMediaOwnerInput } from './delete-profile-media-owner.input.js';
import type { DeleteProfileMediaOwnerOutput } from './delete-profile-media-owner.output.js';

/** Permanently fences a deleted owner before scheduling bounded physical reclamation. */
export class DeleteProfileMediaOwner {
  // #region Constructor
  /** Binds this operation's collaborators. */
  public constructor(private readonly work: ProfileMediaUnitOfWork) {}
  // #endregion

  // #region Methods
  /** Applies this operation within the scoped boundary. */
  public execute(input: DeleteProfileMediaOwnerInput): Promise<DeleteProfileMediaOwnerOutput> {
    return this.work.run(input.owner, async (store) => {
      const owner = await store.lockOwner(input.owner);
      const decision = owner.remove();
      for (const assetId of decision.retireAssetIds) {
        const upload = await store.lockUpload(input.owner, assetId);
        await store.saveUpload(
          upload?.retire() ?? ProfileMediaUpload.retired(input.owner, assetId),
        );
        await store.scheduleCleanup(input.owner, assetId);
      }
      await store.saveOwner(decision.owner);
      await store.scheduleOwnerCleanup(input.owner);
      return { applied: true };
    });
  }
  // #endregion
}
