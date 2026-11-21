import { AttachmentRefusal } from '../../../../models/attachment/attachment-refusal.model.js';
import type { IntakeAttachmentObjectStore } from '../../../../ports/outbound/object-storage/intake-attachment/intake-attachment-object-store.port.js';
import type { AttachmentRuntime } from '../../../../ports/outbound/runtime/attachment/attachment-runtime.port.js';
import type { IntakeAttachmentUnitOfWork } from '../../../../ports/outbound/transactions/intake-attachment/intake-attachment-unit-of-work.port.js';
import type { CompleteIntakeAttachmentUploadInput } from './complete-intake-attachment-upload.input.js';
import type { CompleteIntakeAttachmentUploadOutput } from './complete-intake-attachment-upload.output.js';

/** Verifies a unique immutable candidate and pins it until Task decides the reservation. */
export class CompleteIntakeAttachmentUpload {
  // #region Constructor
  /** Binds the tenant transactions, object store and runtime. */
  public constructor(
    private readonly work: IntakeAttachmentUnitOfWork,
    private readonly objects: IntakeAttachmentObjectStore,
    private readonly runtime: AttachmentRuntime,
    private readonly storageLimit: bigint | null = null,
  ) {}
  // #endregion

  // #region Methods
  /** Registers cleanup before the copy and rechecks Task release before election. */
  public async execute(
    input: CompleteIntakeAttachmentUploadInput,
  ): Promise<CompleteIntakeAttachmentUploadOutput> {
    const candidateId = await this.runtime.newId();
    const candidateKey = `org/${input.organizationId.toLowerCase()}/${candidateId.toLowerCase()}`;
    const preparation = await this.work.run(input.organizationId, async (store) => {
      const current = await store.lock(input);
      if (current === null) throw new AttachmentRefusal('not-found');
      const state = current.snapshot;
      if ((state.status !== 'pending' && state.status !== 'verified') || state.reservation === null)
        throw new AttachmentRefusal('not-found');
      const now = this.runtime.now();
      if (now >= state.reservation.expiresAt) throw new AttachmentRefusal('not-found');
      if (state.status === 'verified') return null;
      current.requireVerificationWindow(now);
      await store.registerCandidate(input, candidateKey, state.reservation.expiresAt);
      return state.reservation.stagingObjectKey;
    });
    if (preparation === null) return { id: input.attachmentId };
    const verification = await this.objects.copyAndVerifyIntake({
      organizationId: input.organizationId,
      stagingKey: preparation,
      candidateKey,
    });
    return this.work.run(input.organizationId, async (store) => {
      const current = await store.lock(input);
      if (current === null) throw new AttachmentRefusal('not-found');
      const state = current.snapshot;
      const now = this.runtime.now();
      if (
        (state.status !== 'pending' && state.status !== 'verified') ||
        state.reservation === null ||
        now >= state.reservation.expiresAt
      )
        throw new AttachmentRefusal('not-found');
      if (state.status === 'verified') return { id: input.attachmentId };
      current.requireVerificationWindow(now);
      if (verification === null) throw new AttachmentRefusal('upload-not-ready');
      const change = current.verify(candidateKey, verification, now);
      if (
        change.event !== null &&
        this.storageLimit !== null &&
        (await store.lockAndReadVerifiedBytes()) + BigInt(verification.sizeBytes) >
          this.storageLimit
      ) {
        throw new AttachmentRefusal('storage-quota-exceeded');
      }
      if (
        change.event !== null &&
        !(await store.electVerified(input, change.intakeAttachment, candidateKey, change.event))
      ) {
        throw new AttachmentRefusal('upload-not-ready');
      }
      return { id: input.attachmentId };
    });
  }
  // #endregion
}
