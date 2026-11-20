import type { FencedCleanupObject } from './fenced-cleanup-object.model.js';

/** Result of an external delete attempted under a specific cleanup lease. */
export interface ObjectErasureResult extends FencedCleanupObject {
  // #region Properties
  /** Whether storage confirmed the object was deleted or absent. */
  readonly erased: boolean;
  // #endregion
}
