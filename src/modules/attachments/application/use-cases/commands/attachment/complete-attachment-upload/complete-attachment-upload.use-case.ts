import { AttachmentError } from '../../../../../domain/errors/attachment/attachment.error.js';
import type { AttachmentSnapshot } from '../../../../../domain/value-objects/attachment/attachment-snapshot.value-object.js';
import { AttachmentRefusal } from '../../../../models/attachment/attachment-refusal.model.js';
import { attachmentView } from '../../../../mappers/attachment/attachment-view.mapper.js';
import type { AttachmentObjectStore } from '../../../../ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import type { AttachmentRuntime } from '../../../../ports/outbound/runtime/attachment/attachment-runtime.port.js';
import type { AttachmentUnitOfWork } from '../../../../ports/outbound/transactions/attachment/attachment-unit-of-work.port.js';
import { retainVerifiedAttachmentCandidate } from '../../../../services/attachment/retain-verified-attachment-candidate.service.js';
import type { CompleteAttachmentUploadInput } from './complete-attachment-upload.input.js';
import type { CompleteAttachmentUploadOutput } from './complete-attachment-upload.output.js';

/** Confirms bytes on a private candidate before electing it in a tenant transaction. */
export class CompleteAttachmentUpload {
  // #region Constructor
  /** Binds transaction, object storage and a source of unique candidates. */
  public constructor(
    private readonly work: AttachmentUnitOfWork,
    private readonly objects: AttachmentObjectStore,
    private readonly runtime: AttachmentRuntime,
    private readonly storageQuotaEnabled = false,
  ) {}
  // #endregion

  // #region Methods
  /** Rechecks task revocation and the uploader after the external copy and verification. */
  public async execute(
    input: CompleteAttachmentUploadInput,
  ): Promise<CompleteAttachmentUploadOutput> {
    const candidateId = await this.runtime.newId();
    const candidateKey = `org/${input.organizationId.toLowerCase()}/${candidateId.toLowerCase()}`;
    const preparation = await this.work.run(input.organizationId, async (store) => {
      if (await store.lockTask(input.taskKey)) throw new AttachmentRefusal('not-found');
      const attachment = await store.lockAttachment(input.taskKey, input.attachmentId);
      if (attachment?.snapshot.authorUserId !== input.actorId.toLowerCase()) {
        throw new AttachmentRefusal('not-found');
      }
      const state = attachment.snapshot;
      if (state.status === 'ready') return { ready: attachmentView(attachment) };
      this.requirePendingUpload(state, this.runtime.now());
      await store.registerCandidate(state.id, candidateKey, state.expiresAt);
      return {
        stagingKey: state.stagingObjectKey,
        sizeBytes: state.sizeBytes,
        contentType: state.contentType,
      };
    });
    if ('ready' in preparation && preparation.ready !== undefined) {
      return { attachment: preparation.ready };
    }
    const verification = await this.objects.copyAndVerify({
      stagingKey: preparation.stagingKey,
      candidateKey,
      sizeBytes: preparation.sizeBytes,
    });
    await retainVerifiedAttachmentCandidate(
      this.objects,
      candidateKey,
      verification,
      preparation,
      () =>
        this.work.run(input.organizationId, async (store) => {
          await store.lockTask(input.taskKey);
          await store.scheduleCandidateCleanup(input.attachmentId, candidateKey);
        }),
    );
    const result = await this.work.run(input.organizationId, async (store) => {
      const reject = async (refusal: AttachmentError | AttachmentRefusal) => {
        await store.scheduleCandidateCleanup(input.attachmentId, candidateKey);
        return { refusal };
      };
      if (await store.lockTask(input.taskKey)) return reject(new AttachmentRefusal('not-found'));
      const attachment = await store.lockAttachment(input.taskKey, input.attachmentId);
      if (attachment?.snapshot.authorUserId !== input.actorId.toLowerCase()) {
        return reject(new AttachmentRefusal('not-found'));
      }
      const state = attachment.snapshot;
      if (state.status === 'ready') {
        await store.scheduleCandidateCleanup(state.id, candidateKey);
        return { attachment: attachmentView(attachment) };
      }
      const now = this.runtime.now();
      let change;
      try {
        this.requirePendingUpload(state, now);
        if (verification === null) throw new AttachmentRefusal('upload-not-ready');
        change = attachment.finalize(verification, now);
      } catch (error) {
        if (error instanceof AttachmentError || error instanceof AttachmentRefusal)
          return reject(error);
        throw error;
      }
      if (change.event !== null) {
        if (this.storageQuotaEnabled) {
          const { usedBytes, limitBytes } = await store.lockAndReadStorageAdmission();
          if (usedBytes + BigInt(verification.sizeBytes) > limitBytes) {
            return reject(new AttachmentRefusal('storage-quota-exceeded'));
          }
        }
        if (!(await store.electCandidate(change.attachment, candidateKey))) {
          return reject(new AttachmentRefusal('upload-not-ready'));
        }
        await store.appendFact(change.event, { type: 'user', id: input.actorId });
      }
      return { attachment: attachmentView(change.attachment) };
    });
    if ('refusal' in result) throw result.refusal;
    return result;
  }

  /** Preserves the expiry response for the uploader after a pending reservation is swept. */
  private requirePendingUpload(state: AttachmentSnapshot, now: Date): void {
    const expiredReservation =
      state.status === 'pending' ||
      (state.status === 'deleted' &&
        state.uploadedAt === null &&
        state.deletedAt !== null &&
        state.deletedAt >= state.expiresAt);
    if (expiredReservation && now >= state.expiresAt) throw new AttachmentError('upload-expired');
    if (state.status === 'deleted') throw new AttachmentRefusal('not-found');
  }
  // #endregion
}
