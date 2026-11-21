import { classifyStorageEntitlement } from '../../../../../domain/policies/attachment/storage-entitlement.policy.js';
import type { AttachmentUnitOfWork } from '../../../../ports/outbound/transactions/attachment/attachment-unit-of-work.port.js';
import type { ApplyStorageEntitlementInput } from './apply-storage-entitlement.input.js';
import type { ApplyStorageEntitlementOutput } from './apply-storage-entitlement.output.js';

/** Updates the Storage-owned projection under the tenant byte admission lock. */
export class ApplyStorageEntitlement {
  // #region Constructor
  /** Binds the tenant transaction used by attachment admission. */
  public constructor(private readonly work: AttachmentUnitOfWork) {}
  // #endregion

  // #region Methods
  /** Advances only a newer Billing version that preserves or raises the byte ceiling. */
  public execute({
    organizationId,
    version,
    limitBytes,
  }: ApplyStorageEntitlementInput): Promise<ApplyStorageEntitlementOutput> {
    const proposed = { version, limitBytes };
    return this.work.run(organizationId, async (store) => {
      const current = await store.lockAndReadStorageEntitlement();
      const decision = classifyStorageEntitlement(current, proposed);
      if (decision !== 'newer') return decision;
      await store.saveStorageEntitlement(proposed);
      return 'applied';
    });
  }
  // #endregion
}
