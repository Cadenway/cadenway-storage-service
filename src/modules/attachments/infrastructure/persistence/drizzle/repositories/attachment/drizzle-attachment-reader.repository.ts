import {
  buildPage,
  decodeCursor,
  encodeCursor,
  ProblemException,
  requireOrganizationId,
} from '@cadenway/nest-common';
import type { TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';

import type { AttachmentPage } from '../../../../../application/models/attachment/attachment-page.model.js';
import type { AttachmentView } from '../../../../../application/models/attachment/attachment-view.model.js';
import type { AttachmentReader } from '../../../../../application/ports/outbound/persistence/attachment/attachment-reader.port.js';
import { attachmentTaskTombstones } from '../../schemas/attachment/attachment-task-tombstones.schema.js';
import { attachments } from '../../schemas/attachment/attachments.schema.js';

type AttachmentRow = typeof attachments.$inferSelect;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

/** A purge revokes reads as soon as its tenant-scoped tombstone is committed. */
const taskIsNotPurged = sql`not exists (
  select 1 from ${attachmentTaskTombstones}
  where ${attachmentTaskTombstones.organizationId} = ${attachments.organizationId}
    and ${attachmentTaskTombstones.taskKey} = ${attachments.taskKey}
    and ${attachmentTaskTombstones.purgedAt} is not null
)`;

function invalidCursor(): never {
  throw new ProblemException({
    status: 400,
    code: 'request.invalid',
    details: {
      issues: [
        {
          in: 'query',
          path: 'cursor',
          code: 'invalid_cursor',
          message: 'Expected the nextCursor of a previous page of this list.',
        },
      ],
    },
  });
}

function view(row: AttachmentRow): AttachmentView {
  if (row.uploadedAt === null) throw new Error('Ready attachment has no verification instant.');
  return {
    id: row.id,
    taskKey: row.taskKey,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    authorUserId: row.authorUserId,
    uploadedAt: row.uploadedAt.toISOString(),
    version: row.version,
  };
}

/** Reads bounded keyset pages of verified files in the authenticated organization. */
export class DrizzleAttachmentReader implements AttachmentReader {
  // #region Constructor
  /** Binds the kit runner which establishes tenant row-level security. */
  public constructor(private readonly runner: TenantTransactionRunner) {}
  // #endregion

  // #region Methods
  /** Returns ready metadata and the selected immutable object for one readable task. */
  public async findReady(
    organizationId: string,
    taskKey: string,
    attachmentId: string,
  ): Promise<{
    readonly attachment: AttachmentView;
    readonly objectKey: string;
  } | null> {
    this.requireTenant(organizationId);
    return this.runner.run(
      async ({ db }) => {
        const rows = await db
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.organizationId, organizationId),
              eq(attachments.taskKey, taskKey),
              eq(attachments.id, attachmentId),
              eq(attachments.status, 'ready'),
              taskIsNotPurged,
            ),
          )
          .limit(1);
        const row = rows[0];
        if (row === undefined) return null;
        if (row.electedObjectKey === null)
          throw new Error('Ready attachment has no elected object.');
        return { attachment: view(row), objectKey: row.electedObjectKey };
      },
      { readOnly: true },
    );
  }

  /** Orders a task page by upload instant and immutable ID. */
  public async listTask(input: {
    readonly organizationId: string;
    readonly taskKey: string;
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<AttachmentPage> {
    this.requireTenant(input.organizationId);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new Error('Attachment page limit is invalid.');
    const filters = {
      organizationId: input.organizationId.toLowerCase(),
      taskKey: input.taskKey,
      order: 'uploaded',
    };
    const position = input.cursor === null ? null : decodeCursor(input.cursor, filters);
    const rawDate = position?.sort[0];
    if (
      position !== null &&
      (!UUID.test(position.id) ||
        position.sort.length !== 1 ||
        typeof rawDate !== 'string' ||
        !Number.isFinite(Date.parse(rawDate)))
    )
      invalidCursor();
    const uploadedAt = typeof rawDate === 'string' ? new Date(rawDate) : null;
    return this.runner.run(
      async ({ db }) => {
        const rows = await db
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.organizationId, input.organizationId),
              eq(attachments.taskKey, input.taskKey),
              eq(attachments.status, 'ready'),
              taskIsNotPurged,
              position === null || uploadedAt === null
                ? undefined
                : or(
                    lt(attachments.uploadedAt, uploadedAt),
                    and(eq(attachments.uploadedAt, uploadedAt), lt(attachments.id, position.id)),
                  ),
            ),
          )
          .orderBy(desc(attachments.uploadedAt), desc(attachments.id))
          .limit(input.limit + 1);
        const page = buildPage(rows, input.limit, (last) => {
          if (last.uploadedAt === null)
            throw new Error('Ready attachment has no verification instant.');
          return encodeCursor({ sort: [last.uploadedAt.toISOString()], id: last.id }, filters);
        });
        return { items: page.items.map(view), nextCursor: page.nextCursor };
      },
      { readOnly: true },
    );
  }

  /** Orders a tenant page by byte size and immutable ID. */
  public async listLargest(input: {
    readonly organizationId: string;
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<AttachmentPage> {
    this.requireTenant(input.organizationId);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new Error('Attachment page limit is invalid.');
    const filters = { organizationId: input.organizationId.toLowerCase(), order: 'largest' };
    const position = input.cursor === null ? null : decodeCursor(input.cursor, filters);
    const size = position?.sort[0];
    if (
      position !== null &&
      (!UUID.test(position.id) ||
        position.sort.length !== 1 ||
        typeof size !== 'number' ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > 26214400)
    )
      invalidCursor();
    return this.runner.run(
      async ({ db }) => {
        const rows = await db
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.organizationId, input.organizationId),
              eq(attachments.status, 'ready'),
              taskIsNotPurged,
              position === null || typeof size !== 'number'
                ? undefined
                : or(
                    lt(attachments.sizeBytes, size),
                    and(eq(attachments.sizeBytes, size), lt(attachments.id, position.id)),
                  ),
            ),
          )
          .orderBy(desc(attachments.sizeBytes), desc(attachments.id))
          .limit(input.limit + 1);
        const page = buildPage(rows, input.limit, (last) =>
          encodeCursor({ sort: [last.sizeBytes], id: last.id }, filters),
        );
        return { items: page.items.map(view), nextCursor: page.nextCursor };
      },
      { readOnly: true },
    );
  }

  /** Rejects a caller-supplied tenant different from the verified request context. */
  private requireTenant(organizationId: string): void {
    if (requireOrganizationId().toLowerCase() !== organizationId.toLowerCase())
      throw new Error('Attachment tenant mismatch.');
  }
  // #endregion
}
