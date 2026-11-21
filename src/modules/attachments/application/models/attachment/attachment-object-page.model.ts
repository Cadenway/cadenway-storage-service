import type { AttachmentObjectReference } from './attachment-object-reference.model.js';

/** A bounded page of physical attachment objects and its opaque storage continuation. */
export interface AttachmentObjectPage {
  // #region Properties
  /** Valid attachment objects present in the physical inventory. */
  readonly objects: readonly AttachmentObjectReference[];

  /** Provider continuation, or null at the end of the inventory. */
  readonly next: string | null;
  // #endregion
}
