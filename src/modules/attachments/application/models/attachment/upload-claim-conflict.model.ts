import type { UploadCapability } from './upload-capability.model.js';

/** The result of encountering a different, still-live owner of the same upload key. */
export type UploadClaimConflict =
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'key-reused' }
  | { readonly kind: 'replay'; readonly response: UploadCapability };
