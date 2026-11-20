import { IntakeAttachment } from '../../../../../domain/aggregates/intake-attachment/intake-attachment.aggregate.js';
import { AttachmentRefusal } from '../../../../models/attachment/attachment-refusal.model.js';
import type { IntakeSigningClaim } from '../../../../models/intake-attachment/intake-signing-claim.model.js';
import type { AttachmentMediaTypeLookup } from '../../../../ports/outbound/media-types/attachment/attachment-media-type-lookup.port.js';
import type { IntakeAttachmentObjectStore } from '../../../../ports/outbound/object-storage/intake-attachment/intake-attachment-object-store.port.js';
import type { AttachmentRuntime } from '../../../../ports/outbound/runtime/attachment/attachment-runtime.port.js';
import type { IntakeAttachmentUnitOfWork } from '../../../../ports/outbound/transactions/intake-attachment/intake-attachment-unit-of-work.port.js';
import type { StartIntakeAttachmentUploadInput } from './start-intake-attachment-upload.input.js';
import type { StartIntakeAttachmentUploadOutput } from './start-intake-attachment-upload.output.js';

/** Resolves a durable signing lease or the original capability of the same allocation. */
function resolveClaim(claim: IntakeSigningClaim): StartIntakeAttachmentUploadOutput {
  if (claim.kind === 'replay') return { capability: claim.capability, replayed: true };
  if (claim.kind === 'in-progress') throw new AttachmentRefusal('request-in-progress');
  if (claim.kind === 'conflict') throw new AttachmentRefusal('idempotency-key-reused');
  throw new AttachmentRefusal('not-found');
}

/** Reserves an anonymous intake upload without exposing the tenant in its staging key. */
export class StartIntakeAttachmentUpload {
  // #region Constructor
  /** Binds transactional state, signer, clock and registered extension lookup. */
  public constructor(
    private readonly work: IntakeAttachmentUnitOfWork,
    private readonly objects: IntakeAttachmentObjectStore,
    private readonly runtime: AttachmentRuntime,
    private readonly mediaTypes: AttachmentMediaTypeLookup,
  ) {}
  // #endregion

  // #region Methods
  /** Persists a short lease before signing and rechecks its owner after signing. */
  public async execute(
    input: StartIntakeAttachmentUploadInput,
  ): Promise<StartIntakeAttachmentUploadOutput> {
    const stagingId = await this.runtime.newId();
    const reservedAt = this.runtime.now();
    if (reservedAt >= input.expiresAt) throw new AttachmentRefusal('not-found');
    const proposed = IntakeAttachment.reserve({
      organizationId: input.organizationId,
      publicationId: input.publicationId,
      id: input.attachmentId,
      stagingObjectKey: `intake/${stagingId.toLowerCase()}`,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      reservedAt,
      expiresAt: input.expiresAt,
    });
    proposed.requireExtensionMediaType(this.mediaTypes.lookup(input.fileName));
    const identity = {
      organizationId: input.organizationId,
      publicationId: input.publicationId,
      attachmentId: input.attachmentId,
    };
    const claim = await this.work.run(input.organizationId, async (store) => {
      await store.lock(identity);
      return store.beginSigning(proposed);
    });
    if (claim.kind !== 'acquired') return resolveClaim(claim);
    try {
      const reservation = claim.attachment.snapshot.reservation;
      if (reservation === null) throw new AttachmentRefusal('not-found');
      const capability = await this.objects.signIntakeUpload({
        organizationId: input.organizationId,
        attachmentId: input.attachmentId,
        stagingKey: reservation.stagingObjectKey,
        contentType: reservation.contentType,
        expiresAt: reservation.uploadExpiresAt,
      });
      const signedExpiry = new Date(capability.expiresAt);
      if (
        capability.id.toLowerCase() !== input.attachmentId.toLowerCase() ||
        !Number.isFinite(signedExpiry.getTime()) ||
        signedExpiry <= this.runtime.now() ||
        signedExpiry > reservation.uploadExpiresAt
      )
        throw new Error('The signed upload does not match its reservation.');

      return await this.work.run(input.organizationId, async (store) => {
        await store.lock(identity);
        const result = await store.completeSigning(identity, claim.claimId, capability);
        if (result.kind !== 'completed') return resolveClaim(result);
        if (this.runtime.now() >= signedExpiry)
          throw new Error('The upload capability expired before reservation.');
        return { capability, replayed: false };
      });
    } catch (error) {
      await this.work
        .run(input.organizationId, async (store) => {
          await store.lock(identity);
          await store.releaseSigning(identity, claim.claimId);
        })
        .catch(() => undefined);
      throw error;
    }
  }
  // #endregion
}
