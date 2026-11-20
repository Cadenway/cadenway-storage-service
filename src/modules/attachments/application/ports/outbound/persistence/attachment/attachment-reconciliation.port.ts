import type { AttachmentObjectPage } from '../../../../models/attachment/attachment-object-page.model.js';
import type { AttachmentReconciliationLease } from '../../../../models/attachment/attachment-reconciliation-lease.model.js';

/** Persists a service-wide inventory position for a single reconciliation worker. */
export interface AttachmentReconciliation {
  // #region Methods
  /** Claims the current position when no live owner holds it. */
  acquire(): Promise<AttachmentReconciliationLease | null>;

  /** Requeues cleaned keys and advances the position in one transaction under a live lease. */
  complete(leaseId: string, page: AttachmentObjectPage): Promise<number | null>;

  /** Releases the given lease while retaining the current position for another attempt. */
  release(leaseId: string): Promise<void>;
  // #endregion
}
