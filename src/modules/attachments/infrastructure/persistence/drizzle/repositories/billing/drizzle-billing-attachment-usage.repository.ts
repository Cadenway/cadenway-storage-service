import { requireOrganizationId } from '@cadenway/nest-common';
import type { TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, asc, desc, eq, gt, inArray, isNotNull, lte } from 'drizzle-orm';

import type { BillingAttachmentUsagePosition } from '../../../../../application/models/billing/billing-attachment-usage-position.model.js';
import type { BillingAttachmentUsageReader } from '../../../../../application/ports/outbound/persistence/billing/billing-attachment-usage-reader.port.js';
import type { BillingAttachmentUsageProjection } from '../../../../../application/projections/billing/billing-attachment-usage.projection.js';
import { attachments } from '../../schemas/attachment/attachments.schema.js';

const MAX_PAGE_WITH_LOOKAHEAD = 101;

/** Reads verified attachment usage and retained terminal versions for one organization. */
export class DrizzleBillingAttachmentUsageReader implements BillingAttachmentUsageReader {
  // #region Constructor
  /** Binds the tenant runner used for a consistent initial upper bound and page. */
  public constructor(private readonly runner: TenantTransactionRunner) {}
  // #endregion

  // #region Methods
  /** Reads a bounded page ordered by immutable attachment ID. */
  public read(
    organizationId: string,
    position: BillingAttachmentUsagePosition | null,
    maximum: number,
  ): ReturnType<BillingAttachmentUsageReader['read']> {
    if (requireOrganizationId().toLowerCase() !== organizationId.toLowerCase()) {
      return Promise.reject(new Error('Billing attachment usage tenant mismatch.'));
    }
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_PAGE_WITH_LOOKAHEAD) {
      return Promise.reject(new Error('The Billing attachment usage page exceeds its bound.'));
    }

    const eligible = and(
      eq(attachments.organizationId, organizationId),
      inArray(attachments.status, ['ready', 'deleted']),
      isNotNull(attachments.uploadedAt),
    );
    return this.runner.run(
      async ({ db, organizationId: tenantId }) => {
        if (tenantId?.toLowerCase() !== organizationId.toLowerCase()) {
          throw new Error('Billing attachment usage tenant mismatch.');
        }
        const upperId =
          position?.upperId ??
          (
            await db
              .select({ id: attachments.id })
              .from(attachments)
              .where(eligible)
              .orderBy(desc(attachments.id))
              .limit(1)
          )[0]?.id ??
          null;
        if (upperId === null) return { upperId, items: [] };

        const rows = await db
          .select({
            fileId: attachments.id,
            version: attachments.version,
            status: attachments.status,
            sizeBytes: attachments.sizeBytes,
          })
          .from(attachments)
          .where(
            and(
              eligible,
              lte(attachments.id, upperId),
              position === null ? undefined : gt(attachments.id, position.afterId),
            ),
          )
          .orderBy(asc(attachments.id))
          .limit(maximum);
        const items: BillingAttachmentUsageProjection[] = rows.map((row) =>
          row.status === 'ready'
            ? { fileId: row.fileId, version: row.version, state: 'ready', sizeBytes: row.sizeBytes }
            : { fileId: row.fileId, version: row.version, state: 'deleted' },
        );
        return { upperId, items };
      },
      { readOnly: true, isolationLevel: 'repeatable read' },
    );
  }
  // #endregion
}
