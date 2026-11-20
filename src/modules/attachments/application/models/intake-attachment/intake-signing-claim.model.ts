import type { UploadCapability } from '../attachment/upload-capability.model.js';
import type { IntakeAttachment } from '../../../domain/aggregates/intake-attachment/intake-attachment.aggregate.js';

/** One signing lease or an existing idempotent result for an intake allocation. */
export type IntakeSigningClaim =
  | { readonly kind: 'acquired'; readonly claimId: string; readonly attachment: IntakeAttachment }
  | { readonly kind: 'replay'; readonly capability: UploadCapability }
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'released' };
