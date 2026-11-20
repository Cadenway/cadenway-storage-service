import { requireOrganizationId } from '@cadenway/nest-common';
import type { TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import type { AttachmentSearchProjectionDecision } from '../../../../../application/models/search-projection/attachment-search-projection-decision.model.js';
import type { AttachmentSearchProjectionPosition } from '../../../../../application/models/search-projection/attachment-search-projection-position.model.js';
import type { AttachmentSearchProjection } from '../../../../../application/models/search-projection/attachment-search-projection.model.js';
import type { AttachmentSearchProjectionReader } from '../../../../../application/ports/outbound/persistence/search-projection/attachment-search-projection-reader.port.js';
import { attachmentTaskTombstones } from '../../schemas/attachment/attachment-task-tombstones.schema.js';
import { attachments } from '../../schemas/attachment/attachments.schema.js';

const purgedTaskMatch = and(
  eq(attachmentTaskTombstones.organizationId, attachments.organizationId),
  eq(attachmentTaskTombstones.taskKey, attachments.taskKey),
  isNotNull(attachmentTaskTombstones.purgedAt),
);
const taskIsNotPurged = sql<boolean>`not exists (
  select 1 from ${attachmentTaskTombstones}
  where ${purgedTaskMatch}
)`;
const projectionColumns = {
  fileId: attachments.id,
  taskKey: attachments.taskKey,
  fileName: attachments.fileName,
  version: attachments.version,
};

function requireTenant(organizationId: string): void {
  if (requireOrganizationId().toLowerCase() !== organizationId.toLowerCase()) {
    throw new Error('Attachment Search tenant mismatch.');
  }
}

/** Reads current attachment Search state from tenant-scoped PostgreSQL snapshots. */
export class DrizzleAttachmentSearchProjectionReader implements AttachmentSearchProjectionReader {
  // #region Constructor
  /** Binds the runner that establishes row-level security for the verified organization. */
  public constructor(private readonly runner: TenantTransactionRunner) {}
  // #endregion

  // #region Methods
  /** Pins the upper eligible ID and reads the first page in the same snapshot. */
  public async list(input: {
    readonly organizationId: string;
    readonly position: AttachmentSearchProjectionPosition | null;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly AttachmentSearchProjection[];
    readonly nextPosition: AttachmentSearchProjectionPosition | null;
  }> {
    requireTenant(input.organizationId);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('Attachment Search page limit is invalid.');
    }
    const eligible = and(
      eq(attachments.organizationId, input.organizationId),
      eq(attachments.status, 'ready'),
      taskIsNotPurged,
    );
    return this.runner.run(
      async ({ db }) => {
        const upperFileId =
          input.position?.upperFileId ??
          (
            await db
              .select({ fileId: attachments.id })
              .from(attachments)
              .where(eligible)
              .orderBy(desc(attachments.id))
              .limit(1)
          )[0]?.fileId;
        if (upperFileId === undefined) return { items: [], nextPosition: null };
        const rows = await db
          .select(projectionColumns)
          .from(attachments)
          .where(
            and(
              eligible,
              lte(attachments.id, upperFileId),
              input.position === null ? undefined : gt(attachments.id, input.position.afterFileId),
            ),
          )
          .orderBy(asc(attachments.id))
          .limit(input.limit + 1);
        const items = rows.slice(0, input.limit);
        const last = items.at(-1);
        return {
          items,
          nextPosition:
            rows.length > input.limit && last !== undefined
              ? { upperFileId, afterFileId: last.fileId }
              : null,
        };
      },
      { readOnly: true, isolationLevel: 'repeatable read' },
    );
  }

  /** Reads one current decision per requested ID, including known terminal versions. */
  public async resolve(
    organizationId: string,
    fileIds: readonly string[],
  ): Promise<readonly AttachmentSearchProjectionDecision[]> {
    requireTenant(organizationId);
    if (fileIds.length < 1 || fileIds.length > 100) {
      throw new Error('Attachment Search batch size is invalid.');
    }
    return this.runner.run(
      async ({ db }) => {
        const rows = await db
          .select({
            ...projectionColumns,
            status: attachments.status,
            taskPurgedAt: attachmentTaskTombstones.purgedAt,
          })
          .from(attachments)
          .leftJoin(attachmentTaskTombstones, purgedTaskMatch)
          .where(
            and(eq(attachments.organizationId, organizationId), inArray(attachments.id, fileIds)),
          );
        const byId = new Map(rows.map((row) => [row.fileId, row]));
        return fileIds.map((fileId): AttachmentSearchProjectionDecision => {
          const row = byId.get(fileId);
          if (row?.status === 'ready' && row.taskPurgedAt === null) {
            return {
              status: 'present',
              projection: {
                fileId,
                taskKey: row.taskKey,
                fileName: row.fileName,
                version: row.version,
              },
            };
          }
          return {
            status: 'absent',
            fileId,
            version: row?.status === 'deleted' ? row.version : null,
          };
        });
      },
      { readOnly: true },
    );
  }
  // #endregion
}
