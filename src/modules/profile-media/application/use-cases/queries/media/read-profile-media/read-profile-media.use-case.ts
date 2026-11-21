import { ProfileMediaError } from '../../../../../domain/errors/media/profile-media.error.js';
import { ProfileMediaUnavailable } from '../../../../models/media/profile-media-unavailable.model.js';
import type { ProfileMediaObjects } from '../../../../ports/outbound/object-storage/media/profile-media-objects.port.js';
import type { ProfileMediaUnitOfWork } from '../../../../ports/outbound/transactions/media/profile-media-unit-of-work.port.js';
import type { ReadProfileMediaInput } from './read-profile-media.input.js';
import type { ReadProfileMediaOutput } from './read-profile-media.output.js';

const readDeadlineMs = 10_000;

/** Reads only an authorized immutable derivative and rechecks it after object storage returns. */
export class ReadProfileMedia {
  // #region Constructor
  /** Binds this operation's collaborators. */
  public constructor(
    private readonly work: ProfileMediaUnitOfWork,
    private readonly objects: ProfileMediaObjects,
  ) {}
  // #endregion

  // #region Methods
  /** Applies this operation within the scoped boundary. */
  public async execute(input: ReadProfileMediaInput): Promise<ReadProfileMediaOutput> {
    const deadline = AbortSignal.timeout(readDeadlineMs);
    const signal =
      input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline]);
    signal.throwIfAborted();
    const derivative = await this.work.run(input.owner, async (store) => {
      if ((await store.lockOwner(input.owner)).snapshot.deleted)
        throw new ProfileMediaError('not-found');
      const upload = await store.lockUpload(input.owner, input.assetId);
      if (upload === null) throw new ProfileMediaError('not-found');
      return upload.readDerivative(input.owner, input.assetId);
    });
    const png = await this.objects.readCandidate(
      {
        owner: input.owner,
        uploadId: input.assetId,
        candidateId: derivative.candidateId,
        sizeBytes: derivative.sizeBytes,
      },
      signal,
    );
    if (png?.byteLength !== derivative.sizeBytes) throw new ProfileMediaUnavailable();
    signal.throwIfAborted();
    await this.work.run(input.owner, async (store) => {
      if ((await store.lockOwner(input.owner)).snapshot.deleted)
        throw new ProfileMediaError('not-found');
      const upload = await store.lockUpload(input.owner, input.assetId);
      if (upload === null) throw new ProfileMediaError('not-found');
      const current = upload.readDerivative(input.owner, input.assetId);
      if (
        current.candidateId !== derivative.candidateId ||
        current.sizeBytes !== derivative.sizeBytes
      ) {
        throw new ProfileMediaError('not-found');
      }
      signal.throwIfAborted();
    });
    return { png };
  }
  // #endregion
}
