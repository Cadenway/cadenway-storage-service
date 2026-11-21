import type {
  SystemTransactionRunner,
  TenantTransactionRunner,
} from '@cadenway/nest-common/database';

import type { ProfileMediaTransaction } from '../../../../../application/models/media/profile-media-transaction.model.js';
import type { ProfileMediaUnitOfWork } from '../../../../../application/ports/outbound/transactions/media/profile-media-unit-of-work.port.js';
import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';
import { DrizzleProfileMediaTransaction } from '../../repositories/media/drizzle-profile-media-transaction.repository.js';
import type { ProfileMediaReceiptCipher } from '../../repositories/media/drizzle-profile-media-transaction.repository.js';

/** Joins the exact account system transaction or verified logo tenant transaction. */
export class DrizzleProfileMediaUnitOfWork implements ProfileMediaUnitOfWork {
  // #region Constructor
  /** Binds both runners and the receipt cipher. */
  public constructor(
    private readonly system: SystemTransactionRunner,
    private readonly tenant: TenantTransactionRunner,
    private readonly cipher: ProfileMediaReceiptCipher,
  ) {}
  // #endregion

  // #region Methods
  /** Enforces the owner against the runner before accessing any row. */
  public run<T>(
    owner: ProfileMediaOwnerBinding,
    work: (store: ProfileMediaTransaction) => Promise<T>,
  ): Promise<T> {
    if (owner.kind === 'avatar')
      return this.system.run((scope) =>
        work(new DrizzleProfileMediaTransaction(scope, owner, this.cipher)),
      );
    return this.tenant.run((scope) =>
      work(new DrizzleProfileMediaTransaction(scope, owner, this.cipher)),
    );
  }
  // #endregion
}
