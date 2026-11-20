import type { AttachmentSearchProjection } from './attachment-search-projection.model.js';

/** Current Search state of a requested file in the caller's organization. */
export type AttachmentSearchProjectionDecision =
  | { readonly status: 'present'; readonly projection: AttachmentSearchProjection }
  | { readonly status: 'absent'; readonly fileId: string; readonly version: number | null };
