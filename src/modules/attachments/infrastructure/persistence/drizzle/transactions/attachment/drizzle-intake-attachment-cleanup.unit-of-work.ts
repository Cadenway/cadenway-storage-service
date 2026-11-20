import type { TenantTransactionRunner } from '@cadenway/nest-common/database';

import type { IntakeAttachmentCleanupTransaction } from '../../../../../application/ports/outbound/persistence/intake-attachment/intake-attachment-cleanup-transaction.port.js';
import type { IntakeAttachmentCleanupUnitOfWork } from '../../../../../application/ports/outbound/transactions/intake-attachment/intake-attachment-cleanup-unit-of-work.port.js';
import { DrizzleIntakeAttachmentCleanupTransaction } from '../../repositories/attachment/drizzle-intake-attachment-cleanup-transaction.repository.js';

/** Opens tenant-scoped intake object cleanup transactions. */
export class DrizzleIntakeAttachmentCleanupUnitOfWork implements IntakeAttachmentCleanupUnitOfWork {
  // #region Constructor
  /** Binds the shared tenant runner. */
  public constructor(private readonly runner: TenantTransactionRunner) {}
  // #endregion

  // #region Methods
  /** Keeps cleanup fencing inside the verified organization. */
  public run<T>(
    organizationId: string,
    work: (store: IntakeAttachmentCleanupTransaction) => Promise<T>,
  ): Promise<T> {
    return this.runner.run((scope) =>
      work(new DrizzleIntakeAttachmentCleanupTransaction(scope, organizationId)),
    );
  }
  // #endregion
}
