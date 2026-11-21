import { describe, expect, it } from 'vitest';

import {
  classifyStorageEntitlement,
  freeStorageEntitlement,
} from './storage-entitlement.policy.js';

describe('Storage byte entitlement updates', () => {
  const current = { version: 3, limitBytes: 3_000_000_000n };

  it.each([
    [2, 4_000_000_000n, 'stale'],
    [3, 3_000_000_000n, 'unchanged'],
    [3, 4_000_000_000n, 'conflict'],
    [4, 2_000_000_000n, 'decrease'],
    [4, 3_000_000_000n, 'newer'],
    [4, 4_000_000_000n, 'newer'],
    [4, 9_007_199_254_740_992n, 'invalid'],
    [4, 0n, 'invalid'],
    [0, 3_000_000_000n, 'invalid'],
    [3.5, 3_000_000_000n, 'invalid'],
    [Number.MAX_SAFE_INTEGER + 1, 3_000_000_000n, 'invalid'],
  ] as const)('compares version %s with the effective ceiling', (version, limitBytes, expected) => {
    expect(classifyStorageEntitlement(current, { version, limitBytes })).toBe(expected);
  });

  it('keeps Free as the lower bound for the first committed snapshot', () => {
    expect(classifyStorageEntitlement(freeStorageEntitlement, freeStorageEntitlement)).toBe(
      'unchanged',
    );
    expect(classifyStorageEntitlement(freeStorageEntitlement, { version: 1, limitBytes: 1n })).toBe(
      'decrease',
    );
  });
});
