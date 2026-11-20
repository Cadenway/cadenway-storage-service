import type { AttachmentObjectPage } from '../../../../models/attachment/attachment-object-page.model.js';

/** Lists physical objects through the configured attachment bucket's internal endpoint. */
export interface AttachmentObjectInventory {
  // #region Methods
  /** Lists one bounded page, starting over when the supplied continuation is null. */
  listAttachmentObjects(
    continuation: string | null,
    signal: AbortSignal,
  ): Promise<AttachmentObjectPage>;
  // #endregion
}
