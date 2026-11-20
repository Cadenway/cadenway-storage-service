import { ProfileMediaUpload } from '../../../../../domain/aggregates/media/profile-media-upload.aggregate.js';
import type { ProfileMediaUnitOfWork } from '../../../../ports/outbound/transactions/media/profile-media-unit-of-work.port.js';
import type { AbandonProfileMediaInput } from './abandon-profile-media.input.js';
import type { AbandonProfileMediaOutput } from './abandon-profile-media.output.js';

/** Fences an abandoned upload, including a decision received before its reservation. */
export class AbandonProfileMedia {
  // #region Constructor
  /** Binds this operation's collaborators. */
  public constructor(private readonly work: ProfileMediaUnitOfWork) {}
  // #endregion

  // #region Methods
  /** Applies this operation within the scoped boundary. */
  public execute(input: AbandonProfileMediaInput): Promise<AbandonProfileMediaOutput> {
    return this.work.run(input.owner, async (store) => {
      const owner = await store.lockOwner(input.owner);
      const upload = await store.lockUpload(input.owner, input.uploadId);
      if (owner.snapshot.assetId !== input.uploadId.toLowerCase()) {
        await store.saveUpload(
          upload?.retire() ?? ProfileMediaUpload.retired(input.owner, input.uploadId),
        );
        await store.scheduleCleanup(input.owner, input.uploadId);
      }
      return { applied: true };
    });
  }
  // #endregion
}
