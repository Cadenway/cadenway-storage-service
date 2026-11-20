import type { AttachmentObjectInventory } from '../../../../ports/outbound/object-storage/attachment/attachment-object-inventory.port.js';
import type { AttachmentReconciliation } from '../../../../ports/outbound/persistence/attachment/attachment-reconciliation.port.js';
import type { ReconcileAttachmentObjectsInput } from './reconcile-attachment-objects.input.js';
import type { ReconcileAttachmentObjectsOutput } from './reconcile-attachment-objects.output.js';

/** Requeues cleaned objects that appeared again after an ambiguous storage write. */
export class ReconcileAttachmentObjects {
  // #region Constructor
  /** Binds the durable cursor and the physical object inventory. */
  public constructor(
    private readonly reconciliation: AttachmentReconciliation,
    private readonly inventory: AttachmentObjectInventory,
  ) {}
  // #endregion

  // #region Methods
  /** Visits one inventory page without holding a database transaction during storage I/O. */
  public async execute({
    signal,
  }: ReconcileAttachmentObjectsInput): Promise<ReconcileAttachmentObjectsOutput> {
    signal.throwIfAborted();
    const lease = await this.reconciliation.acquire();
    if (lease === null) return { requeued: 0 };

    try {
      signal.throwIfAborted();
      const page = await this.inventory.listAttachmentObjects(lease.continuation, signal);
      signal.throwIfAborted();
      const requeued = await this.reconciliation.complete(lease.id, page);
      return { requeued: requeued ?? 0 };
    } catch (error) {
      // The lease deadline still allows recovery if PostgreSQL cannot release it here.
      await this.reconciliation.release(lease.id).catch(() => undefined);
      throw error;
    }
  }
  // #endregion
}
