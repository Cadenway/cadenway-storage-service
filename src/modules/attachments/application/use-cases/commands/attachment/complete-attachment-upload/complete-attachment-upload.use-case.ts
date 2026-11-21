import { AttachmentError } from '../../../../../domain/errors/attachment/attachment.error.js';
import type { AttachmentSnapshot } from '../../../../../domain/value-objects/attachment/attachment-snapshot.value-object.js';
import { AttachmentRefusal } from '../../../../models/attachment/attachment-refusal.model.js';
import { attachmentView } from '../../../../mappers/attachment/attachment-view.mapper.js';
import type { AttachmentObjectStore } from '../../../../ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import type { AttachmentRuntime } from '../../../../ports/outbound/runtime/attachment/attachment-runtime.port.js';
import type { AttachmentUnitOfWork } from '../../../../ports/outbound/transactions/attachment/attachment-unit-of-work.port.js';
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
      return { stagingKey: state.stagingObjectKey };
    });
    if ('ready' in preparation && preparation.ready !== undefined) {
      return { attachment: preparation.ready };
    }
    const verification = await this.objects.copyAndVerify({
      stagingKey: preparation.stagingKey,
      candidateKey,
    });
    return this.work.run(input.organizationId, async (store) => {
      if (await store.lockTask(input.taskKey)) throw new AttachmentRefusal('not-found');
      const attachment = await store.lockAttachment(input.taskKey, input.attachmentId);
      if (attachment?.snapshot.authorUserId !== input.actorId.toLowerCase()) {
        throw new AttachmentRefusal('not-found');
      }
      const state = attachment.snapshot;
      if (state.status === 'ready') return { attachment: attachmentView(attachment) };
      const now = this.runtime.now();
      this.requirePendingUpload(state, now);
      if (verification === null) throw new AttachmentRefusal('upload-not-ready');
      const change = attachment.finalize(verification, now);
      if (change.event !== null) {
        if (!(await store.electCandidate(change.attachment, candidateKey))) {
          throw new AttachmentRefusal('upload-not-ready');
        }
        await store.appendFact(change.event, { type: 'user', id: input.actorId });
      }
      return { attachment: attachmentView(change.attachment) };
    });
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
