import type { TenantTransactionRunner, TransactionScope } from '@cadenway/nest-common/database';

import type { AttachmentCleanupTransaction } from '../../../../../application/ports/outbound/persistence/attachment/attachment-cleanup-transaction.port.js';
import type { AttachmentCleanupUnitOfWork } from '../../../../../application/ports/outbound/transactions/attachment/attachment-cleanup-unit-of-work.port.js';
import type { AttachmentActor } from '../../../../../application/models/attachment/attachment-actor.model.js';
import type { AttachmentFact } from '../../../../../domain/events/attachment/attachment-fact.event.js';
import { DrizzleAttachmentCleanupTransaction } from '../../repositories/attachment/drizzle-attachment-cleanup-transaction.repository.js';

type FactWriter = (
  scope: TransactionScope,
  fact: AttachmentFact,
  actor: AttachmentActor,
) => Promise<void>;

/** Runs cleanup and its outbox facts in the caller's tenant transaction. */
export class DrizzleAttachmentCleanupUnitOfWork implements AttachmentCleanupUnitOfWork {
  // #region Constructor
  /** Binds the transaction runner and outbox writer. */
  public constructor(
    private readonly runner: TenantTransactionRunner,
    private readonly writeFact: FactWriter,
  ) {}
  // #endregion

  // #region Methods
  /** Runs a cleanup page and its facts under the verified organization scope. */
  public run<T>(
    organizationId: string,
    work: (store: AttachmentCleanupTransaction) => Promise<T>,
  ): Promise<T> {
    return this.runner.run((scope) =>
      work(
        new DrizzleAttachmentCleanupTransaction(scope, organizationId, (fact, actor) =>
          this.writeFact(scope, fact, actor),
        ),
      ),
    );
  }
  // #endregion
}
