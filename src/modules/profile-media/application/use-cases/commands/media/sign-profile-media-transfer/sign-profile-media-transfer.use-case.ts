import { ProfileMediaUpload } from '../../../../../domain/aggregates/media/profile-media-upload.aggregate.js';
import { ProfileMediaError } from '../../../../../domain/errors/media/profile-media.error.js';
import { ProfileMediaUnavailable } from '../../../../models/media/profile-media-unavailable.model.js';
import type { ProfileMediaObjects } from '../../../../ports/outbound/object-storage/media/profile-media-objects.port.js';
import type { ProfileMediaRuntime } from '../../../../ports/outbound/runtime/media/profile-media-runtime.port.js';
import type { ProfileMediaUnitOfWork } from '../../../../ports/outbound/transactions/media/profile-media-unit-of-work.port.js';
import type { SignProfileMediaTransferInput } from './sign-profile-media-transfer.input.js';
import type { SignProfileMediaTransferOutput } from './sign-profile-media-transfer.output.js';

/** Signs exactly one upload capability and retains its original response. */
export class SignProfileMediaTransfer {
  // #region Constructor
  /** Binds this operation's collaborators. */
  public constructor(
    private readonly work: ProfileMediaUnitOfWork,
    private readonly objects: ProfileMediaObjects,
    private readonly runtime: ProfileMediaRuntime,
  ) {}
  // #endregion

  // #region Methods
  /** Applies this operation within the scoped boundary. */
  public async execute(
    input: SignProfileMediaTransferInput,
  ): Promise<SignProfileMediaTransferOutput> {
    input.signal?.throwIfAborted();
    const claim = await this.work.run(input.owner, async (store) => {
      const owner = await store.lockOwner(input.owner);
      if (owner.snapshot.deleted) throw new ProfileMediaError('not-found');
      let upload = await store.lockUpload(input.owner, input.uploadId);
      const fresh = upload === null;
      if (upload === null) {
        upload = ProfileMediaUpload.reserve(input, this.runtime.now());
        await store.insertUpload(upload);
      } else {
        upload.assertEquivalent(input);
      }
      const capability = await store.findCapability(input.owner, input.uploadId);
      upload.requireSignable(this.runtime.now(), capability !== null);
      if (capability !== null) return { capability, leaseId: null };
      const leaseId = await store.claimSigning(input.owner, input.uploadId);
      if (leaseId === null) throw new ProfileMediaError('request-in-progress');
      // A restored pre-receipt reservation may already have issued its original grant.
      if (!fresh && this.objects.oneShotUploads === true) {
        throw new ProfileMediaError('upload-expired');
      }
      return { capability: null, leaseId };
    });
    if (claim.capability !== null) return { capability: claim.capability };
    const leaseId = claim.leaseId;
    try {
      const capability = await this.objects.sign(input, input.signal);
      input.signal?.throwIfAborted();
      if (
        capability.uploadId.toLowerCase() !== input.uploadId.toLowerCase() ||
        new Date(capability.expiresAt).getTime() !== input.expiresAt.getTime()
      ) {
        throw new ProfileMediaUnavailable();
      }
      return await this.work.run(input.owner, async (store) => {
        if ((await store.lockOwner(input.owner)).snapshot.deleted)
          throw new ProfileMediaError('not-found');
        const upload = await store.lockUpload(input.owner, input.uploadId);
        if (upload === null) throw new ProfileMediaError('not-found');
        upload.assertEquivalent(input);
        upload.requireSignable(this.runtime.now(), false);
        if (!(await store.completeSigning(input.owner, input.uploadId, leaseId, capability))) {
          throw new ProfileMediaUnavailable();
        }
        input.signal?.throwIfAborted();
        return { capability };
      });
    } catch (error) {
      await this.work
        .run(input.owner, async (store) => {
          await store.lockOwner(input.owner);
          await store.releaseSigning(input.owner, input.uploadId, leaseId);
        })
        .catch(() => undefined);
      throw error;
    }
  }
  // #endregion
}
