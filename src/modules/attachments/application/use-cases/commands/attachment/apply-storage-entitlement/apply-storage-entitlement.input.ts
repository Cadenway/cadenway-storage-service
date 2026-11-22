import type { StorageEntitlementSnapshot } from '../../../../../domain/value-objects/attachment/storage-entitlement-snapshot.value-object.js';

/** A validated Billing snapshot targeted to the caller's verified tenant scope. */
export interface ApplyStorageEntitlementInput extends StorageEntitlementSnapshot {
  // #region Properties
  /** Tenant of the trusted Billing snapshot and transaction. */
  readonly organizationId: string;
  // #endregion
}
