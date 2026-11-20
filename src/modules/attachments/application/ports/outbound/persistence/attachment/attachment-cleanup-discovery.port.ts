import type { AttachmentCleanupTask } from '../../../../models/attachment/attachment-cleanup-task.model.js';

/** Pages pending cleanup work across organizations without changing attachment state. */
export interface AttachmentCleanupDiscovery {
  // #region Methods
  /** Finds the next ordered batch of task tombstones after the supplied position. */
  listPurgedTasks(after: AttachmentCleanupTask | null): Promise<readonly AttachmentCleanupTask[]>;

  /** Finds the next ordered batch of distinct organizations with objects due at the cutoff. */
  listDueObjectOrganizations(cutoff: Date, after: string | null): Promise<readonly string[]>;
  // #endregion
}
