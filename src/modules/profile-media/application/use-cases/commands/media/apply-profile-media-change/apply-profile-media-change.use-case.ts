import { ProfileMediaUpload } from '../../../../../domain/aggregates/media/profile-media-upload.aggregate.js';
import { ProfileMediaError } from '../../../../../domain/errors/media/profile-media.error.js';
import type { ProfileMediaUnitOfWork } from '../../../../ports/outbound/transactions/media/profile-media-unit-of-work.port.js';
import type { ApplyProfileMediaChangeInput } from './apply-profile-media-change.input.js';
import type { ApplyProfileMediaChangeOutput } from './apply-profile-media-change.output.js';

/** Projects owner generations and fences explicitly retired candidates in the event transaction. */
export class ApplyProfileMediaChange {
  // #region Constructor
  /** Binds this operation's collaborators. */
  public constructor(private readonly work: ProfileMediaUnitOfWork) {}
  // #endregion

  // #region Methods
  /** Applies this operation within the scoped boundary. */
  public execute(input: ApplyProfileMediaChangeInput): Promise<ApplyProfileMediaChangeOutput> {
    return this.work.run(input.owner, async (store) => {
      const owner = await store.lockOwner(input.owner);
      const decision = owner.change(input);
      if (decision.adoptAssetId !== null) {
        const upload = await store.lockUpload(input.owner, decision.adoptAssetId);
        if (upload === null) throw new ProfileMediaError('upload-not-ready');
        await store.saveUpload(upload.adopt());
      }
      for (const assetId of decision.retireAssetIds) {
        const upload = await store.lockUpload(input.owner, assetId);
        await store.saveUpload(
          upload?.retire() ?? ProfileMediaUpload.retired(input.owner, assetId),
        );
        await store.scheduleCleanup(input.owner, assetId);
      }
      await store.saveOwner(decision.owner);
      return { applied: true };
    });
  }
  // #endregion
}
