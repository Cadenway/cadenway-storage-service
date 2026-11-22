import { AttachmentError } from '../../../domain/errors/attachment/attachment.error.js';
import { requireAttachmentVerification } from '../../../domain/policies/attachment/attachment-file.policy.js';
import type { AttachmentVerification } from '../../../domain/value-objects/attachment/attachment-verification.value-object.js';
import type { AttachmentObjectStore } from '../../ports/outbound/object-storage/attachment/attachment-object-store.port.js';

/** Records independent restore evidence before a validated object becomes visible to backups. */
export async function retainVerifiedAttachmentCandidate(
  objects: Pick<AttachmentObjectStore, 'retainCandidate'>,
  candidateKey: string,
  verification: AttachmentVerification | null,
  declaration: { readonly contentType: string; readonly sizeBytes: number },
  rejectCandidate: () => Promise<void>,
): Promise<void> {
  if (verification === null) return;
  try {
    requireAttachmentVerification(verification, declaration.contentType, declaration.sizeBytes);
  } catch (error) {
    // The completion transaction still reports the domain error after rechecking authorization.
    if (error instanceof AttachmentError) return;
    throw error;
  }
  try {
    await objects.retainCandidate(candidateKey);
  } catch (error) {
    // The marker PUT may have succeeded. This attempt has not yet opened its election transaction.
    await rejectCandidate().catch(() => undefined);
    throw error;
  }
}
