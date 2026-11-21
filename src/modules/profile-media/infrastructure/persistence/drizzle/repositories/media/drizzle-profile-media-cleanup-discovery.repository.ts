import type { SystemTransactionRunner } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';

import type { ProfileMediaOwnerBinding } from '../../../../../domain/value-objects/media/profile-media-owner-binding.value-object.js';
import {
  profileMediaObjects,
  profileMediaOwners,
} from '../../schemas/media/profile-media.schema.js';

/** Discovers only bounded owner identifiers, never private object metadata. */
export class DrizzleProfileMediaCleanupDiscovery {
  // #region Constructor
  /** Binds the read-only system discovery runner. */
  public constructor(private readonly system: SystemTransactionRunner) {}
  // #endregion

  // #region Methods
  /** Seeks past the previous owner; callers must sweep each result in its authorized scope. */
  public listDueOwners(
    after: ProfileMediaOwnerBinding | null,
    limit: number,
  ): Promise<readonly ProfileMediaOwnerBinding[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Invalid profile owner discovery page.');
    const owners = profileMediaOwners;
    const objects = profileMediaObjects;
    const cursor =
      after === null
        ? sql.empty()
        : sql`and (${owners.ownerKind}, ${owners.ownerId}) > (${after.kind}, ${after.id}::uuid)`;
    return this.system.run(
      async ({ db }) => {
        const rows = await db.execute<{ kind: 'avatar' | 'organization-logo'; id: string }>(sql`
        select ${owners.ownerKind} as kind, ${owners.ownerId} as id from ${owners}
        where (${owners.cleanupRequested} = true or exists (
          select 1 from ${objects}
          where ${objects.ownerKind} = ${owners.ownerKind} and ${objects.ownerId} = ${owners.ownerId}
            and ${objects.status} in ('active','fenced') and ${objects.cleanupAfter} <= clock_timestamp()
            and (${objects.leasedUntil} is null or ${objects.leasedUntil} <= clock_timestamp())
        )) ${cursor}
        order by ${owners.ownerKind}, ${owners.ownerId} limit ${limit}
      `);
        return rows.rows;
      },
      { readOnly: true },
    );
  }
  // #endregion
}
