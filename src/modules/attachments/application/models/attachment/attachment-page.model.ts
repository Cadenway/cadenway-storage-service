import type { AttachmentView } from './attachment-view.model.js';

/** A tenant-scoped page of ready attachments. */
export interface AttachmentPage {
  // #region Properties
  /** Ready attachments in the order defined by the query. */
  readonly items: readonly AttachmentView[];

  /** Opaque continuation cursor, or null on the last page. */
  readonly nextCursor: string | null;
  // #endregion
}
