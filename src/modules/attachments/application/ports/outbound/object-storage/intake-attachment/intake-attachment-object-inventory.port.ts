import type { IntakeAttachmentObjectPage } from '../../../../models/intake-attachment/intake-attachment-object-page.model.js';

/** Lists opaque anonymous staging keys from the configured object bucket. */
export interface IntakeAttachmentObjectInventory {
  // #region Methods
  /** Lists one bounded page, starting over when the continuation is null. */
  listIntakeObjects(
    continuation: string | null,
    signal: AbortSignal,
  ): Promise<IntakeAttachmentObjectPage>;
  // #endregion
}
