import type { IntakeAttachmentCleanupTransaction } from '../../persistence/intake-attachment/intake-attachment-cleanup-transaction.port.js';

/** Runs an anonymous attachment cleanup batch in its tenant transaction. */
export interface IntakeAttachmentCleanupUnitOfWork {
  // #region Methods
  /** Runs the callback in the verified organization scope. */
  run<T>(
    organizationId: string,
    work: (store: IntakeAttachmentCleanupTransaction) => Promise<T>,
  ): Promise<T>;
  // #endregion
}
