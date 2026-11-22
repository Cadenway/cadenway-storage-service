import { describe, expect, it } from 'vitest';

import {
  classifyStorageEntitlement,
  freeStorageEntitlement,
} from './storage-entitlement.policy.js';

describe('Storage byte entitlement updates', () => {
  const current = { version: 3, limitBytes: 3_000_000_000n };
  const team = { plan: 'team', seatLimit: 9 };
  const free = { ...freeStorageEntitlement, plan: 'free', seatLimit: 5 };

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
    expect(classifyStorageEntitlement(current, { ...team, version, limitBytes })).toBe(expected);
  });

  it('updates to a newer canonical Free snapshot and acknowledges its replay', () => {
    const returned = { ...free, version: 6 };
    expect(classifyStorageEntitlement(current, returned)).toBe('newer');
    expect(classifyStorageEntitlement(returned, returned)).toBe('unchanged');
    expect(classifyStorageEntitlement(returned, { ...team, ...current })).toBe('stale');
    expect(classifyStorageEntitlement(current, { ...free, version: current.version })).toBe(
      'conflict',
    );
  });

  it('recovers a Free version even when the previous update has not been observed', () => {
    expect(classifyStorageEntitlement(freeStorageEntitlement, free)).toBe('unchanged');
    expect(classifyStorageEntitlement(freeStorageEntitlement, { ...free, version: 6 })).toBe(
      'newer',
    );
  });

  it('rejects invalid Free snapshots and keeps the PostgreSQL byte floor', () => {
    expect(classifyStorageEntitlement(current, { ...free, version: 4, seatLimit: 6 })).toBe(
      'invalid',
    );
    expect(
      classifyStorageEntitlement(current, { ...free, version: 4, limitBytes: 3_000_000_000n }),
    ).toBe('invalid');
    expect(
      classifyStorageEntitlement(freeStorageEntitlement, {
        ...team,
        version: 1,
        limitBytes: 1_999_999_999n,
      }),
    ).toBe('invalid');
  });
});
