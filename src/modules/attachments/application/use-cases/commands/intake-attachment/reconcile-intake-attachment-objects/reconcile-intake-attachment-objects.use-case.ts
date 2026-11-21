import type { IntakeAttachmentObjectInventory } from '../../../../ports/outbound/object-storage/intake-attachment/intake-attachment-object-inventory.port.js';
import type { IntakeAttachmentReconciliation } from '../../../../ports/outbound/persistence/intake-attachment/intake-attachment-reconciliation.port.js';
import type { ReconcileAttachmentObjectsInput } from '../../attachment/reconcile-attachment-objects/reconcile-attachment-objects.input.js';
import type { ReconcileAttachmentObjectsOutput } from '../../attachment/reconcile-attachment-objects/reconcile-attachment-objects.output.js';

/** Requeues late writes to previously cleaned opaque staging objects. */
export class ReconcileIntakeAttachmentObjects {
  // #region Constructor
  /** Binds the dedicated inventory cursor and object store. */
  public constructor(
    private readonly reconciliation: IntakeAttachmentReconciliation,
    private readonly inventory: IntakeAttachmentObjectInventory,
  ) {}
  // #endregion

  // #region Methods
  /** Visits one physical page without holding a database transaction during storage I/O. */
  public async execute({
    signal,
  }: ReconcileAttachmentObjectsInput): Promise<ReconcileAttachmentObjectsOutput> {
    signal.throwIfAborted();
    const lease = await this.reconciliation.acquire();
    if (lease === null) return { requeued: 0 };
    try {
      signal.throwIfAborted();
      const page = await this.inventory.listIntakeObjects(lease.continuation, signal);
      signal.throwIfAborted();
      const requeued = await this.reconciliation.complete(lease.id, page);
      return { requeued: requeued ?? 0 };
    } catch (error) {
      await this.reconciliation.release(lease.id).catch(() => undefined);
      throw error;
    }
  }
  // #endregion
}
