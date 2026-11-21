import { describe, expect, it } from 'vitest';

import { ProfileMediaOwner } from './profile-media-owner.aggregate.js';

const CAMILLE = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30';
const FIRST = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01';
const SECOND = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b02';
const THIRD = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b03';
const AVATAR = { kind: 'avatar', id: CAMILLE } as const;

describe('ProfileMediaOwner', () => {
  it('projects adoption, replacement and removal by image generation', () => {
    const owner = ProfileMediaOwner.empty(AVATAR);
    const accepted = owner.change({ generation: 2, assetId: FIRST, oldAssetId: null });
    expect(accepted.adoptAssetId).toBe(FIRST);
    expect(accepted.retireAssetIds).toEqual([]);
    const replaced = accepted.owner.change({ generation: 4, assetId: SECOND, oldAssetId: FIRST });
    expect(replaced.adoptAssetId).toBe(SECOND);
    expect(replaced.retireAssetIds).toEqual([FIRST]);
    const removed = replaced.owner.change({ generation: 5, assetId: null, oldAssetId: SECOND });
    expect(removed.owner.snapshot).toEqual({
      owner: AVATAR,
      generation: 5,
      assetId: null,
      deleted: false,
    });
    expect(removed.adoptAssetId).toBeNull();
    expect(removed.retireAssetIds).toEqual([SECOND]);
  });

  it('reclaims earlier assets when a later reference arrives before both older facts', () => {
    const latest = ProfileMediaOwner.empty(AVATAR).change({
      generation: 3,
      assetId: THIRD,
      oldAssetId: SECOND,
    }).owner;
    const lateFirst = latest.change({ generation: 1, assetId: FIRST, oldAssetId: null });
    expect(lateFirst).toEqual({ owner: latest, adoptAssetId: null, retireAssetIds: [FIRST] });
    const lateSecond = latest.change({ generation: 2, assetId: SECOND, oldAssetId: FIRST });
    expect(lateSecond).toEqual({
      owner: latest,
      adoptAssetId: null,
      retireAssetIds: [FIRST, SECOND],
    });
    expect(latest.snapshot.assetId).toBe(THIRD);
  });

  it('replays the active reference without readopting or retiring it', () => {
    const latest = ProfileMediaOwner.empty(AVATAR).change({
      generation: 2,
      assetId: SECOND,
      oldAssetId: FIRST,
    }).owner;
    expect(latest.change({ generation: 2, assetId: SECOND, oldAssetId: FIRST })).toEqual({
      owner: latest,
      adoptAssetId: null,
      retireAssetIds: [FIRST],
    });
    expect(() => latest.change({ generation: 2, assetId: THIRD, oldAssetId: FIRST })).toThrow(
      expect.objectContaining({ reason: 'invalid-state' }),
    );
  });

  it('keeps every later reference unavailable after account deletion', () => {
    const latest = ProfileMediaOwner.empty(AVATAR).change({
      generation: 1,
      assetId: FIRST,
      oldAssetId: null,
    }).owner;
    const removed = latest.remove();
    expect(removed.retireAssetIds).toEqual([FIRST]);
    expect(removed.owner.snapshot).toMatchObject({ deleted: true, assetId: null });
    expect(removed.owner.change({ generation: 2, assetId: SECOND, oldAssetId: FIRST })).toEqual({
      owner: removed.owner,
      adoptAssetId: null,
      retireAssetIds: [FIRST, SECOND],
    });
    expect(removed.owner.remove()).toEqual({
      owner: removed.owner,
      adoptAssetId: null,
      retireAssetIds: [],
    });
  });
});
