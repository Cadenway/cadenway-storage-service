import type { TransactionScope } from '@cadenway/nest-common/database';
import { and, asc, eq, lte, sql } from 'drizzle-orm';

import type { CleanupCursor } from '../../../../../application/models/attachment/cleanup-cursor.model.js';
import type { FencedCleanupObject } from '../../../../../application/models/attachment/fenced-cleanup-object.model.js';
import type { ObjectErasureResult } from '../../../../../application/models/attachment/object-erasure-result.model.js';
import type { IntakeAttachmentCleanupTransaction } from '../../../../../application/ports/outbound/persistence/intake-attachment/intake-attachment-cleanup-transaction.port.js';
import { intakeAttachmentCandidates } from '../../schemas/attachment/intake-attachment-candidates.schema.js';

const ERASURE_LEASE_SECONDS = 15 * 60;
const ERASURE_RETRY_SECONDS = 60;

/** Fences due intake objects under the same allocation lock as claim and verification. */
export class DrizzleIntakeAttachmentCleanupTransaction implements IntakeAttachmentCleanupTransaction {
  // #region Properties
  /** Canonical verified organization. */
  private readonly organizationId: string;
  // #endregion

  // #region Constructor
  /** Requires the transaction for this exact tenant. */
  public constructor(
    private readonly scope: TransactionScope,
    organizationId: string,
  ) {
    if (
      scope.kind !== 'tenant' ||
      scope.organizationId?.toLowerCase() !== organizationId.toLowerCase()
    )
      throw new Error('Intake cleanup requires its tenant transaction.');
    this.organizationId = organizationId.toLowerCase();
  }
  // #endregion

  // #region Methods
  /** Advances after every examined candidate, including candidates concurrently elected. */
  public async fenceDueObjects(
    cutoff: Date,
    after: CleanupCursor | null,
    limit: number,
  ): Promise<{
    readonly objects: readonly FencedCleanupObject[];
    readonly next: CleanupCursor | null;
  }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new RangeError('Intake cleanup page must contain at most 500 rows.');
    const table = intakeAttachmentCandidates;
    const rows = await this.scope.db
      .select({
        publicationId: table.publicationId,
        attachmentId: table.attachmentId,
        objectKey: table.objectKey,
        cleanupAfter: table.cleanupAfter,
        generation: table.cleanupGeneration,
      })
      .from(table)
      .where(
        and(
          eq(table.organizationId, this.organizationId),
          sql`${table.status} in ('staging', 'active', 'fenced')`,
          lte(table.cleanupAfter, cutoff),
          after === null
            ? undefined
            : sql`(${table.cleanupAfter}, ${table.objectKey}) > (${after.cleanupAfter.toISOString()}::timestamptz, ${after.objectKey})`,
        ),
      )
      .orderBy(asc(table.cleanupAfter), asc(table.objectKey))
      .limit(limit);
    const last = rows.at(-1);
    if (last === undefined) return { objects: [], next: null };

    const locks = [
      ...new Set(
        rows.map((row) =>
          ['intake-attachment', this.organizationId, row.publicationId, row.attachmentId].join(':'),
        ),
      ),
    ].sort();
    for (const key of locks) {
      await this.scope.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    }
    const scanned = sql.join(
      rows.map(
        (row) =>
          sql`(${row.publicationId}::uuid, ${row.attachmentId}::uuid, ${row.objectKey}::text, ${row.cleanupAfter.toISOString()}::timestamptz, ${row.generation}::integer)`,
      ),
      sql`, `,
    );
    const fenced = await this.scope.db.execute<{ objectKey: string; generation: number }>(sql`
      update ${table}
      set status = 'fenced',
          cleanup_after = greatest(clock_timestamp(), ${cutoff.toISOString()}::timestamptz)
            + make_interval(secs => ${ERASURE_LEASE_SECONDS}),
          cleanup_generation = ${table.cleanupGeneration} + 1
      from (values ${scanned}) as scanned (publication_id, attachment_id, object_key, cleanup_after, generation)
      where ${table.organizationId} = ${this.organizationId}::uuid
        and ${table.publicationId} = scanned.publication_id
        and ${table.attachmentId} = scanned.attachment_id
        and ${table.objectKey} = scanned.object_key
        and ${table.status} in ('staging', 'active', 'fenced')
        and ${table.cleanupAfter} = scanned.cleanup_after
        and ${table.cleanupGeneration} = scanned.generation
      returning ${table.objectKey} as "objectKey", ${table.cleanupGeneration} as "generation"
    `);
    return {
      objects: fenced.rows,
      next:
        rows.length === limit
          ? { cleanupAfter: last.cleanupAfter, objectKey: last.objectKey }
          : null,
    };
  }

  /** Settles only the current fencing generation after object storage responds. */
  public async settleObjectErasures(results: readonly ObjectErasureResult[]): Promise<number> {
    if (results.length === 0) return 0;
    if (results.length > 500)
      throw new RangeError('Intake cleanup settlement exceeds its page size.');
    const table = intakeAttachmentCandidates;
    const outcomes = sql.join(
      results.map(
        (result) =>
          sql`(${result.objectKey}::text, ${result.generation}::integer, ${result.erased}::boolean)`,
      ),
      sql`, `,
    );
    const settled = await this.scope.db.execute<{ erased: boolean }>(sql`
      update ${table}
      set status = case when outcome.erased then 'cleaned' else 'fenced' end,
          cleanup_after = case when outcome.erased then ${table.cleanupAfter}
            else greatest(clock_timestamp(), ${table.cleanupAfter} - make_interval(secs => ${ERASURE_LEASE_SECONDS}))
              + make_interval(secs => ${ERASURE_RETRY_SECONDS}) end,
          cleanup_generation = ${table.cleanupGeneration} + 1
      from (values ${outcomes}) as outcome (object_key, generation, erased)
      where ${table.organizationId} = ${this.organizationId}::uuid
        and ${table.status} = 'fenced'
        and ${table.objectKey} = outcome.object_key
        and ${table.cleanupGeneration} = outcome.generation
      returning outcome.erased
    `);
    return settled.rows.filter(({ erased }) => erased).length;
  }
  // #endregion
}
