import type { TransactionScope } from '@cadenway/nest-common/database';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';

import type { AttachmentActor } from '../../../../../application/models/attachment/attachment-actor.model.js';
import type { AttachmentCleanupPage } from '../../../../../application/models/attachment/attachment-cleanup-page.model.js';
import type { CleanupCursor } from '../../../../../application/models/attachment/cleanup-cursor.model.js';
import type { FencedCleanupObject } from '../../../../../application/models/attachment/fenced-cleanup-object.model.js';
import type { ObjectErasureResult } from '../../../../../application/models/attachment/object-erasure-result.model.js';
import type { AttachmentCleanupTransaction } from '../../../../../application/ports/outbound/persistence/attachment/attachment-cleanup-transaction.port.js';
import { Attachment } from '../../../../../domain/aggregates/attachment/attachment.aggregate.js';
import type { AttachmentFact } from '../../../../../domain/events/attachment/attachment-fact.event.js';
import { attachmentCandidates } from '../../schemas/attachment/attachment-candidates.schema.js';
import { attachmentTaskTombstones } from '../../schemas/attachment/attachment-task-tombstones.schema.js';
import { attachments } from '../../schemas/attachment/attachments.schema.js';
import { DrizzleAttachmentTransaction } from './drizzle-attachment-transaction.repository.js';

type FactWriter = (fact: AttachmentFact, actor: AttachmentActor) => Promise<void>;
const ERASURE_LEASE_SECONDS = 15 * 60;
const ERASURE_RETRY_SECONDS = 60;

/** Cleans a single tenant under the same locks used for reservation and finalization. */
export class DrizzleAttachmentCleanupTransaction
  extends DrizzleAttachmentTransaction
  implements AttachmentCleanupTransaction
{
  // #region Properties
  /** Canonical tenant identifier for every cleanup query. */
  private readonly tenantId: string;
  // #endregion

  // #region Constructor
  /** Uses the caller's transaction and transactional outbox writer. */
  public constructor(
    private readonly transaction: TransactionScope,
    organizationId: string,
    writeFact: FactWriter,
  ) {
    super(transaction, organizationId, writeFact, undefined);
    this.tenantId = organizationId.toLowerCase();
  }
  // #endregion

  // #region Methods
  /** Locks the existing tombstone and retains the original purge actor. */
  public async lockPendingPurge(taskKey: string): Promise<AttachmentActor | null> {
    const rows = await this.transaction.db
      .select()
      .from(attachmentTaskTombstones)
      .where(
        and(
          eq(attachmentTaskTombstones.organizationId, this.tenantId),
          eq(attachmentTaskTombstones.taskKey, taskKey),
          eq(attachmentTaskTombstones.cleanupPending, true),
        ),
      )
      .for('update');
    const row = rows[0];
    if (row === undefined) return null;
    if (
      row.purgedAt === null ||
      row.purgeActorId === null ||
      (row.purgeActorType !== 'user' &&
        row.purgeActorType !== 'automation' &&
        row.purgeActorType !== 'git' &&
        row.purgeActorType !== 'system')
    )
      throw new Error('Pending task purge has no valid actor.');
    return { type: row.purgeActorType, id: row.purgeActorId };
  }

  /** Locks one bounded page in stable attachment-ID order. */
  public async lockPurgeAttachments(
    taskKey: string,
    limit: number,
  ): Promise<readonly Attachment[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new RangeError('Attachment purge page must contain at most 500 rows.');
    const rows = await this.transaction.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.organizationId, this.tenantId),
          eq(attachments.taskKey, taskKey),
          inArray(attachments.status, ['pending', 'ready']),
        ),
      )
      .orderBy(asc(attachments.id))
      .limit(limit)
      .for('update');
    return rows.map((row) => {
      if (row.status !== 'pending' && row.status !== 'ready')
        throw new Error('Unexpected attachment status in purge page.');
      return Attachment.rehydrate({ ...row, status: row.status });
    });
  }

  /** Clears the pending flag only for this locked tenant task. */
  public async finishPurge(taskKey: string): Promise<void> {
    await this.transaction.db
      .update(attachmentTaskTombstones)
      .set({ cleanupPending: false })
      .where(
        and(
          eq(attachmentTaskTombstones.organizationId, this.tenantId),
          eq(attachmentTaskTombstones.taskKey, taskKey),
          eq(attachmentTaskTombstones.cleanupPending, true),
        ),
      );
  }

  /** Claims a bounded page after locking the tasks and then their attachments. */
  public async fenceDueObjects(
    cutoff: Date,
    after: CleanupCursor | null,
    limit: number,
  ): Promise<AttachmentCleanupPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new RangeError('Attachment cleanup page must contain at most 500 rows.');
    const candidates = await this.transaction.db
      .select({
        taskKey: attachments.taskKey,
        attachmentId: attachmentCandidates.attachmentId,
        objectKey: attachmentCandidates.objectKey,
        cleanupAfter: attachmentCandidates.cleanupAfter,
        generation: attachmentCandidates.cleanupGeneration,
      })
      .from(attachmentCandidates)
      .innerJoin(
        attachments,
        and(
          eq(attachments.organizationId, attachmentCandidates.organizationId),
          eq(attachments.id, attachmentCandidates.attachmentId),
        ),
      )
      .where(
        and(
          eq(attachmentCandidates.organizationId, this.tenantId),
          sql`${attachmentCandidates.status} in ('staging', 'active', 'fenced')`,
          lte(attachmentCandidates.cleanupAfter, cutoff),
          after === null
            ? undefined
            : sql`(${attachmentCandidates.cleanupAfter}, ${attachmentCandidates.objectKey}) > (${after.cleanupAfter.toISOString()}::timestamptz, ${after.objectKey})`,
        ),
      )
      .orderBy(asc(attachmentCandidates.cleanupAfter), asc(attachmentCandidates.objectKey))
      .limit(limit);
    const last = candidates.at(-1);
    if (last === undefined) return { objects: [], pendingAttachments: [], next: null };

    const locked = await this.lockCandidateAttachments(
      [...new Set(candidates.map(({ taskKey }) => taskKey))].sort(),
      [...new Set(candidates.map(({ attachmentId }) => attachmentId))],
    );
    const byId = new Map(locked.map((attachment) => [attachment.id, attachment]));
    const eligible = candidates.filter(({ attachmentId, taskKey, objectKey }) => {
      const attachment = byId.get(attachmentId);
      return (
        attachment?.taskKey === taskKey &&
        (attachment.status !== 'ready' || attachment.electedObjectKey !== objectKey)
      );
    });
    const objects = await this.leaseObjects(cutoff, eligible);
    const claimedKeys = new Set(objects.map(({ objectKey }) => objectKey));
    const claimedAttachments = new Set(
      eligible
        .filter(({ objectKey }) => claimedKeys.has(objectKey))
        .map(({ attachmentId }) => attachmentId),
    );
    return {
      objects,
      pendingAttachments: locked
        .filter((row) => row.status === 'pending' && claimedAttachments.has(row.id))
        .map((row) => Attachment.rehydrate({ ...row, status: 'pending' })),
      next:
        candidates.length === limit
          ? { cleanupAfter: last.cleanupAfter, objectKey: last.objectKey }
          : null,
    };
  }

  /** Locks the task keys in stable order before selecting their attachment rows. */
  private async lockCandidateAttachments(
    taskKeys: string[],
    attachmentIds: string[],
  ): Promise<(typeof attachments.$inferSelect)[]> {
    const { db } = this.transaction;
    await db
      .insert(attachmentTaskTombstones)
      .values(taskKeys.map((taskKey) => ({ organizationId: this.tenantId, taskKey })))
      .onConflictDoNothing();
    const lockedTasks = await db
      .select({ taskKey: attachmentTaskTombstones.taskKey })
      .from(attachmentTaskTombstones)
      .where(
        and(
          eq(attachmentTaskTombstones.organizationId, this.tenantId),
          inArray(attachmentTaskTombstones.taskKey, taskKeys),
        ),
      )
      .orderBy(asc(attachmentTaskTombstones.taskKey))
      .for('update');
    if (lockedTasks.length !== taskKeys.length) throw new Error('Task locks were not retained.');
    return db
      .select()
      .from(attachments)
      .where(
        and(eq(attachments.organizationId, this.tenantId), inArray(attachments.id, attachmentIds)),
      )
      .orderBy(asc(attachments.taskKey), asc(attachments.id))
      .for('update');
  }

  /** Rechecks the scanned generation and moves each claimed object beyond the current sweep. */
  private async leaseObjects(
    cutoff: Date,
    candidates: readonly (CleanupCursor & FencedCleanupObject)[],
  ): Promise<readonly FencedCleanupObject[]> {
    if (candidates.length === 0) return [];
    const { objectKey, cleanupAfter, cleanupGeneration, organizationId, status } =
      attachmentCandidates;
    const scanned = sql.join(
      candidates.map(
        (candidate) =>
          sql`(${candidate.objectKey}::text, ${candidate.cleanupAfter.toISOString()}::timestamptz, ${candidate.generation}::integer)`,
      ),
      sql`, `,
    );
    const result = await this.transaction.db.execute<{ objectKey: string; generation: number }>(sql`
      update ${attachmentCandidates}
      set status = 'fenced',
          cleanup_after = greatest(clock_timestamp(), ${cutoff.toISOString()}::timestamptz)
            + make_interval(secs => ${ERASURE_LEASE_SECONDS}),
          cleanup_generation = ${cleanupGeneration} + 1
      from (values ${scanned}) as scanned (object_key, cleanup_after, generation)
      where ${organizationId} = ${this.tenantId}::uuid
        and ${status} in ('staging', 'active', 'fenced')
        and ${objectKey} = scanned.object_key
        and ${cleanupAfter} = scanned.cleanup_after
        and ${cleanupGeneration} = scanned.generation
      returning ${objectKey} as "objectKey", ${cleanupGeneration} as "generation"
    `);
    return result.rows;
  }

  /** Confirms or reschedules only erasures whose lease generation still matches. */
  public async settleObjectErasures(results: readonly ObjectErasureResult[]): Promise<number> {
    if (results.length === 0) return 0;
    const { objectKey, cleanupAfter, cleanupGeneration, organizationId, status } =
      attachmentCandidates;
    const outcomes = sql.join(
      results.map(
        (result) =>
          sql`(${result.objectKey}::text, ${result.generation}::integer, ${result.erased}::boolean)`,
      ),
      sql`, `,
    );
    const settled = await this.transaction.db.execute<{ erased: boolean }>(sql`
      update ${attachmentCandidates}
      set status = case when outcome.erased then 'cleaned' else 'fenced' end,
          cleanup_after = case when outcome.erased then ${cleanupAfter}
            else greatest(clock_timestamp(), ${cleanupAfter} - make_interval(secs => ${ERASURE_LEASE_SECONDS}))
              + make_interval(secs => ${ERASURE_RETRY_SECONDS}) end,
          cleanup_generation = ${cleanupGeneration} + 1
      from (values ${outcomes}) as outcome (object_key, generation, erased)
      where ${organizationId} = ${this.tenantId}::uuid
        and ${status} = 'fenced'
        and ${objectKey} = outcome.object_key
        and ${cleanupGeneration} = outcome.generation
      returning outcome.erased
    `);
    return settled.rows.filter(({ erased }) => erased).length;
  }
  // #endregion
}
