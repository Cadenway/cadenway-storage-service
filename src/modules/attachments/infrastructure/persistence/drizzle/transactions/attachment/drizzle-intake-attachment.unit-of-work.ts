import type { TenantTransactionRunner, TransactionScope } from '@cadenway/nest-common/database';

import type { IntakeAttachmentTransaction } from '../../../../../application/models/intake-attachment/intake-attachment-transaction.model.js';
import type { IntakeAttachmentUnitOfWork } from '../../../../../application/ports/outbound/transactions/intake-attachment/intake-attachment-unit-of-work.port.js';
import type { AttachmentFact } from '../../../../../domain/events/attachment/attachment-fact.event.js';
import type { IntakeAttachmentVerified } from '../../../../../domain/events/intake-attachment/intake-attachment-verified.event.js';
import type { UploadReceiptCodec } from '../../../../adapters/crypto/upload-receipt.codec.js';
import { DrizzleIntakeAttachmentTransaction } from '../../repositories/attachment/drizzle-intake-attachment-transaction.repository.js';

/** Runs intake changes and both fact writers in the verified tenant transaction. */
export class DrizzleIntakeAttachmentUnitOfWork implements IntakeAttachmentUnitOfWork {
  // #region Constructor
  /** Binds the tenant runner, transaction-bound outbox writers and encrypted receipt codec. */
  public constructor(
    private readonly runner: TenantTransactionRunner,
    private readonly writeVerified: (
      scope: TransactionScope,
      fact: IntakeAttachmentVerified,
    ) => Promise<void>,
    private readonly writeFile: (scope: TransactionScope, fact: AttachmentFact) => Promise<void>,
    private readonly receipts: UploadReceiptCodec | undefined,
  ) {}
  // #endregion

  // #region Methods
  /** Joins an existing tenant transaction when processing an authoritative Task event. */
  public run<T>(
    organizationId: string,
    work: (store: IntakeAttachmentTransaction) => Promise<T>,
  ): Promise<T> {
    return this.runner.run((scope) =>
      work(
        new DrizzleIntakeAttachmentTransaction(
          scope,
          organizationId,
          (fact) => this.writeVerified(scope, fact),
          (fact) => this.writeFile(scope, fact),
          this.receipts,
        ),
      ),
    );
  }
  // #endregion
}
