import type { ProfileMediaEraser } from '../../../../ports/outbound/object-storage/media/profile-media-eraser.port.js';
import type { ProfileMediaCleanup } from '../../../../ports/outbound/transactions/media/profile-media-cleanup.port.js';
import type { CleanProfileMediaInput } from './clean-profile-media.input.js';
import type { CleanProfileMediaOutput } from './clean-profile-media.output.js';

const maximumBatchSize = 500;

/** Reclaims a bounded batch through durable generation-fenced deletion leases. */
export class CleanProfileMedia {
  // #region Constructor
  /** Binds the durable cleanup ledger and the private object store. */
  public constructor(
    private readonly cleanup: ProfileMediaCleanup,
    private readonly objects: ProfileMediaEraser,
  ) {}
  // #endregion

  // #region Methods
  /** Leaves failed and cancelled leases available for later retry. */
  public async execute(input: CleanProfileMediaInput): Promise<CleanProfileMediaOutput> {
    input.signal?.throwIfAborted();
    const leases = await this.cleanup.claim(maximumBatchSize);
    let deleted = 0;
    for (const [index, lease] of leases.entries()) {
      try {
        input.signal?.throwIfAborted();
        await this.objects.erase(lease, input.signal);
        input.signal?.throwIfAborted();
        await this.cleanup.complete(lease);
        deleted += 1;
      } catch (error) {
        await this.cleanup.release(leases.slice(index)).catch(() => undefined);
        throw error;
      }
    }
    return { deleted };
  }
  // #endregion
}
