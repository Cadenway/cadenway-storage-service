import type { AttachmentReconciliationLease } from '../../../../models/attachment/attachment-reconciliation-lease.model.js';
import type { IntakeAttachmentObjectPage } from '../../../../models/intake-attachment/intake-attachment-object-page.model.js';

/** Persists a separate inventory position for opaque staging keys. */
export interface IntakeAttachmentReconciliation {
  // #region Methods
  /** Acquires the next inventory page or returns null while another worker owns it. */
  acquire(): Promise<AttachmentReconciliationLease | null>;

  /** Advances the cursor and requeues known cleaned objects under a live lease. */
  complete(leaseId: string, page: IntakeAttachmentObjectPage): Promise<number | null>;

  /** Releases a failed attempt without advancing its cursor. */
  release(leaseId: string): Promise<void>;
  // #endregion
}
