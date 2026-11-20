import type { IntakeAttachmentTransaction } from '../../../../models/intake-attachment/intake-attachment-transaction.model.js';

/** Runs a reservation lifecycle transition under one verified organization. */
export interface IntakeAttachmentUnitOfWork {
  // #region Methods
  /** Supplies one tenant-scoped transaction and its outbox. */
  run<T>(
    organizationId: string,
    work: (store: IntakeAttachmentTransaction) => Promise<T>,
  ): Promise<T>;
  // #endregion
}
