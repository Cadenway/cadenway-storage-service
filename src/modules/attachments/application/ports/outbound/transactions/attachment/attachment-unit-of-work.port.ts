import type { AttachmentTransaction } from '../../../../models/attachment/attachment-transaction.model.js';

/** Opens and commits one transaction using the authenticated organization scope. */
export interface AttachmentUnitOfWork {
  // #region Methods
  /** Runs all supplied operations in one transaction for the given organization. */
  run<T>(organizationId: string, work: (store: AttachmentTransaction) => Promise<T>): Promise<T>;
  // #endregion
}
