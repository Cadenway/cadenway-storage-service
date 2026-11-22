import type { StorageEntitlement } from './storage-entitlement.value-object.js';

/** The verified Billing snapshot used to decide whether a byte ceiling can change. */
export interface StorageEntitlementSnapshot extends StorageEntitlement {
  // #region Properties
  /** The Billing plan identifier, including plans unknown to Storage. */
  readonly plan: string;

  /** The seat limit attached to this full entitlement snapshot. */
  readonly seatLimit: number;
  // #endregion
}
