import type { StorageEntitlementSnapshot } from '../../value-objects/attachment/storage-entitlement-snapshot.value-object.js';
import type { StorageEntitlement } from '../../value-objects/attachment/storage-entitlement.value-object.js';

/** The Free baseline applies until Storage accepts a committed entitlement. */
export const freeStorageEntitlement: StorageEntitlement = {
  version: 0,
  limitBytes: 2_000_000_000n,
};

/**
 * Classifies a Billing snapshot against the locked Storage projection.
 * Billing's subscription.changed.v1 baseline authorizes a return to Free at five seats and two
 * billion bytes. An entitlement's version may advance even when Storage missed an earlier snapshot.
 */
export function classifyStorageEntitlement(
  current: StorageEntitlement,
  proposed: StorageEntitlementSnapshot,
): 'newer' | 'unchanged' | 'stale' | 'conflict' | 'decrease' | 'invalid' {
  const isCanonicalFree =
    proposed.plan === 'free' &&
    proposed.seatLimit === 5 &&
    proposed.limitBytes === freeStorageEntitlement.limitBytes;
  if (
    !Number.isSafeInteger(proposed.version) ||
    proposed.version < 0 ||
    !Number.isSafeInteger(proposed.seatLimit) ||
    proposed.seatLimit < 1 ||
    proposed.limitBytes < freeStorageEntitlement.limitBytes ||
    proposed.limitBytes > BigInt(Number.MAX_SAFE_INTEGER) ||
    ((proposed.version === 0 || proposed.plan === 'free') && !isCanonicalFree)
  ) {
    return 'invalid';
  }

  if (proposed.version < current.version) return 'stale';
  if (proposed.version === current.version) {
    return proposed.limitBytes === current.limitBytes ? 'unchanged' : 'conflict';
  }
  return proposed.limitBytes < current.limitBytes && !isCanonicalFree ? 'decrease' : 'newer';
}
