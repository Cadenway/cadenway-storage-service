import type { AttachmentPage } from '../../../../models/attachment/attachment-page.model.js';
import type { AttachmentView } from '../../../../models/attachment/attachment-view.model.js';

/** Tenant-scoped reads of ready metadata and the elected object reference. */
export interface AttachmentReader {
  // #region Methods
  /** Reads a ready attachment for its task and organization. */
  findReady(
    organizationId: string,
    taskKey: string,
    attachmentId: string,
  ): Promise<{
    readonly attachment: AttachmentView;
    readonly objectKey: string;
  } | null>;

  /** Lists a readable task's ready attachments in descending upload order. */
  listTask(input: {
    readonly organizationId: string;
    readonly taskKey: string;
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<AttachmentPage>;

  /** Lists ready attachments in descending size order for an authorized administrator. */
  listLargest(input: {
    readonly organizationId: string;
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<AttachmentPage>;
  // #endregion
}
