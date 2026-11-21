import type { StorageEntitlement } from '../../value-objects/attachment/storage-entitlement.value-object.js';

/** The Free baseline applies until Storage accepts a committed entitlement. */
export const freeStorageEntitlement: StorageEntitlement = {
  version: 0,
  limitBytes: 2_000_000_000n,
};

/** Classifies a Billing snapshot against the locked Storage projection. */
export function classifyStorageEntitlement(
  current: StorageEntitlement,
  proposed: StorageEntitlement,
): 'newer' | 'unchanged' | 'stale' | 'conflict' | 'decrease' | 'invalid' {
  if (
    !Number.isSafeInteger(proposed.version) ||
    proposed.version < 0 ||
    proposed.limitBytes < 1n ||
    proposed.limitBytes > BigInt(Number.MAX_SAFE_INTEGER) ||
    (proposed.version === 0 && proposed.limitBytes !== freeStorageEntitlement.limitBytes)
  ) {
    return 'invalid';
  }

  if (proposed.version < current.version) return 'stale';
  if (proposed.version === current.version) {
    return proposed.limitBytes === current.limitBytes ? 'unchanged' : 'conflict';
  }
  return proposed.limitBytes < current.limitBytes ? 'decrease' : 'newer';
}
