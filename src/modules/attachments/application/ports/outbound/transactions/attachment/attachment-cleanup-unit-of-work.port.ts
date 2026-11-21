import type { AttachmentCleanupTransaction } from '../../persistence/attachment/attachment-cleanup-transaction.port.js';

/** Runs one cleanup batch in a transaction scoped to the supplied verified organization. */
export interface AttachmentCleanupUnitOfWork {
  // #region Methods
  /** Runs the callback within the tenant-bound transaction. */
  run<T>(
    organizationId: string,
    work: (store: AttachmentCleanupTransaction) => Promise<T>,
  ): Promise<T>;
  // #endregion
}
