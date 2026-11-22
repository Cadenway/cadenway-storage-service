import { Attachment } from '../../../../../domain/aggregates/attachment/attachment.aggregate.js';
import { AttachmentRefusal } from '../../../../models/attachment/attachment-refusal.model.js';
import type { AttachmentTransaction } from '../../../../models/attachment/attachment-transaction.model.js';
import type { UploadClaimConflict } from '../../../../models/attachment/upload-claim-conflict.model.js';
import type { AttachmentMediaTypeLookup } from '../../../../ports/outbound/media-types/attachment/attachment-media-type-lookup.port.js';
import type { AttachmentObjectStore } from '../../../../ports/outbound/object-storage/attachment/attachment-object-store.port.js';
import type { AttachmentRuntime } from '../../../../ports/outbound/runtime/attachment/attachment-runtime.port.js';
import type { AttachmentUnitOfWork } from '../../../../ports/outbound/transactions/attachment/attachment-unit-of-work.port.js';
import type { StartAttachmentUploadInput } from './start-attachment-upload.input.js';
import type { StartAttachmentUploadOutput } from './start-attachment-upload.output.js';

/** Returns the original response or the stable refusal for a conflicting claim. */
function resolveUploadClaim(claim: UploadClaimConflict): StartAttachmentUploadOutput {
  if (claim.kind === 'replay') return { capability: claim.response, replayed: true };
  if (claim.kind === 'in-progress') throw new AttachmentRefusal('request-in-progress');
  throw new AttachmentRefusal('idempotency-key-reused');
}

/** Reserves a tenant-scoped upload and the original replay response atomically. */
export class StartAttachmentUpload {
  // #region Constructor
  /** Binds the database, capability signer, runtime and extension registry. */
  public constructor(
    private readonly work: AttachmentUnitOfWork,
    private readonly objects: AttachmentObjectStore,
    private readonly runtime: AttachmentRuntime,
    private readonly mediaTypes: AttachmentMediaTypeLookup,
  ) {}
  // #endregion

  // #region Methods
  /** Commits the lease before signing so concurrent callers can observe it. */
  public async execute(input: StartAttachmentUploadInput): Promise<StartAttachmentUploadOutput> {
    const key = input.idempotencyKey;
    if (key === undefined) return this.signAndPersist(input);

    const claim = await this.work.run(input.organizationId, async (store) => {
      await this.requireActiveTask(store, input.taskKey);
      return store.claimUpload(input.actorId, input.taskKey, key, input.fingerprint);
    });
    if (claim.kind !== 'acquired') return resolveUploadClaim(claim);

    try {
      return await this.signAndPersist(input, { key, id: claim.claimId });
    } catch (error) {
      // The bounded lease still expires if the database cannot accept this release.
      await this.work
        .run(input.organizationId, async (store) => {
          await store.lockTask(input.taskKey);
          await store.releaseUploadClaim(input.actorId, input.taskKey, key, claim.claimId);
        })
        .catch(() => undefined);
      throw error;
    }
  }

  /** Signs outside a transaction and persists the response with the exact policy expiry. */
  private async signAndPersist(
    input: StartAttachmentUploadInput,
    claim?: { readonly key: string; readonly id: string },
  ): Promise<StartAttachmentUploadOutput> {
    const id = await this.runtime.newId();
    const stageId = await this.runtime.newId();
    const reservedAt = this.runtime.now();
    const expiresAt = new Date(reservedAt.getTime() + 5 * 60_000);
    const prefix = `org/${input.organizationId.toLowerCase()}/`;
    const attachment = Attachment.reserve({
      id,
      organizationId: input.organizationId,
      taskKey: input.taskKey,
      authorUserId: input.actorId,
      objectKey: prefix + id.toLowerCase(),
      stagingObjectKey: prefix + stageId.toLowerCase(),
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      reservedAt,
      expiresAt,
    });
    attachment.requireExtensionMediaType(this.mediaTypes.lookup(input.fileName));
    const capability = await this.objects.signUpload({
      attachmentId: attachment.snapshot.id,
      stagingKey: attachment.snapshot.stagingObjectKey,
      contentType: attachment.snapshot.contentType,
      sizeBytes: attachment.snapshot.sizeBytes,
      expiresAt,
    });
    const signedExpiry = new Date(capability.expiresAt);
    if (
      capability.id !== attachment.snapshot.id ||
      !(signedExpiry > reservedAt && signedExpiry <= expiresAt)
    )
      throw new Error('The signed upload does not match its reservation.');
    const signedReservation = Attachment.rehydrate({
      ...attachment.snapshot,
      expiresAt: signedExpiry,
    });

    return this.work.run(input.organizationId, async (store) => {
      await this.requireActiveTask(store, input.taskKey);
      if (this.runtime.now() >= signedExpiry)
        throw new Error('The upload capability expired before reservation.');
      if (claim !== undefined) {
        const result = await store.completeUploadClaim(
          input.actorId,
          input.taskKey,
          claim.key,
          input.fingerprint,
          claim.id,
          capability,
        );
        if (result.kind !== 'completed') return resolveUploadClaim(result);
      }
      const { usedBytes, limitBytes } = await store.lockAndReadStorageAdmission(true);
      if (usedBytes + BigInt(signedReservation.snapshot.sizeBytes) > limitBytes) {
        throw new AttachmentRefusal('storage-quota-exceeded');
      }
      await store.insertReservation(signedReservation, this.objects.oneShotUploads);
      if (this.runtime.now() >= signedExpiry)
        throw new Error('The upload capability expired before reservation.');
      return { capability, replayed: false };
    });
  }

  /** Serializes the claim and final reservation with permanent task revocation. */
  private async requireActiveTask(store: AttachmentTransaction, taskKey: string): Promise<void> {
    if (await store.lockTask(taskKey)) throw new AttachmentRefusal('not-found');
  }
  // #endregion
}
