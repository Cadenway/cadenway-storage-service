import { ProfileMediaError } from '../../../../../domain/errors/media/profile-media.error.js';
import { ProfileMediaUnavailable } from '../../../../models/media/profile-media-unavailable.model.js';
import type { ProfileMediaImageProcessor } from '../../../../ports/outbound/image-processing/media/profile-media-image-processor.port.js';
import type { ProfileMediaObjects } from '../../../../ports/outbound/object-storage/media/profile-media-objects.port.js';
import type { ProfileMediaRuntime } from '../../../../ports/outbound/runtime/media/profile-media-runtime.port.js';
import type { ProfileMediaUnitOfWork } from '../../../../ports/outbound/transactions/media/profile-media-unit-of-work.port.js';
import type { PrepareProfileMediaInput } from './prepare-profile-media.input.js';
import type { PrepareProfileMediaOutput } from './prepare-profile-media.output.js';

/** Verifies one source and elects its unique immutable PNG under the owner lock. */
export class PrepareProfileMedia {
  // #region Properties
  /** Allows one in-flight image buffer per process and does not queue additional uploads. */
  private activePreparation: symbol | null = null;
  // #endregion

  // #region Constructor
  /** Binds this operation's collaborators. */
  public constructor(
    private readonly work: ProfileMediaUnitOfWork,
    private readonly objects: ProfileMediaObjects,
    private readonly processor: ProfileMediaImageProcessor,
    private readonly runtime: ProfileMediaRuntime,
  ) {}
  // #endregion

  // #region Methods
  /** Applies this operation within the scoped boundary. */
  public async execute(input: PrepareProfileMediaInput): Promise<PrepareProfileMediaOutput> {
    input.signal?.throwIfAborted();
    const permit = Symbol();
    try {
      return await this.prepare(input, permit);
    } finally {
      if (this.activePreparation === permit) this.activePreparation = null;
    }
  }

  /** Keeps the permit through reservation, verification, upload and the election transaction. */
  private async prepare(
    input: PrepareProfileMediaInput,
    permit: symbol,
  ): Promise<PrepareProfileMediaOutput> {
    const candidateId = await this.runtime.newId();
    const reserved = await this.work.run(input.owner, async (store) => {
      if ((await store.lockOwner(input.owner)).snapshot.deleted)
        throw new ProfileMediaError('not-found');
      const upload = await store.lockUpload(input.owner, input.uploadId);
      if (upload === null) throw new ProfileMediaError('not-found');
      upload.assertUploader(input.owner, input.uploaderUserId);
      upload.requirePreparable(this.runtime.now());
      const preparation = upload.getPreparation();
      if (preparation !== null) return { preparation, contentType: null, sizeBytes: null };
      const declaration = upload.snapshot.declaration;
      if (declaration === null) throw new ProfileMediaError('upload-superseded');
      if (this.activePreparation !== null && this.activePreparation !== permit) {
        throw new ProfileMediaUnavailable();
      }
      this.activePreparation = permit;
      await store.registerCandidate(input.owner, input.uploadId, candidateId);
      return {
        preparation: null,
        contentType: declaration.contentType,
        sizeBytes: declaration.sizeBytes,
      };
    });
    if (reserved.preparation !== null) return { preparation: reserved.preparation };
    const source = await this.objects.readSource(
      {
        owner: input.owner,
        uploadId: input.uploadId,
        contentType: reserved.contentType,
        sizeBytes: reserved.sizeBytes,
      },
      input.signal,
    );
    if (source === null) throw new ProfileMediaError('upload-not-ready');
    if (source.byteLength !== reserved.sizeBytes) throw new ProfileMediaError('invalid-image');
    const result = await this.processor.transform(
      {
        kind: input.owner.kind,
        contentType: reserved.contentType,
        bytes: source,
        candidateId,
      },
      input.signal,
    );
    if (
      result.verification.candidateId !== candidateId ||
      result.verification.derivative.sizeBytes !== result.png.byteLength
    ) {
      throw new ProfileMediaUnavailable();
    }
    await this.objects.putCandidate({ ...input, candidateId, png: result.png }, input.signal);
    input.signal?.throwIfAborted();
    return this.work.run(input.owner, async (store) => {
      if ((await store.lockOwner(input.owner)).snapshot.deleted)
        throw new ProfileMediaError('not-found');
      const upload = await store.lockUpload(input.owner, input.uploadId);
      if (upload === null) throw new ProfileMediaError('not-found');
      upload.assertUploader(input.owner, input.uploaderUserId);
      const elected = upload.prepare(result.verification, this.runtime.now());
      if (elected !== upload && !(await store.electCandidate(elected, candidateId))) {
        throw new ProfileMediaUnavailable();
      }
      const preparation = elected.getPreparation();
      if (preparation === null) throw new ProfileMediaUnavailable();
      return { preparation };
    });
  }
  // #endregion
}
