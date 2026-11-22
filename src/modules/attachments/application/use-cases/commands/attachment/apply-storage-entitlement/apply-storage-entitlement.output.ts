import type { classifyStorageEntitlement } from '../../../../../domain/policies/attachment/storage-entitlement.policy.js';

/** Whether a Billing snapshot changed the effective verified-byte limit. */
export type ApplyStorageEntitlementOutput =
  'applied' | Exclude<ReturnType<typeof classifyStorageEntitlement>, 'newer'>;
