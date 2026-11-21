import { BillingAttachmentUsageError } from '../../../../models/billing/billing-attachment-usage-error.model.js';
import type { BillingAttachmentUsageCursor } from '../../../../ports/outbound/crypto/billing/billing-attachment-usage-cursor.port.js';
import type { BillingAttachmentUsageReader } from '../../../../ports/outbound/persistence/billing/billing-attachment-usage-reader.port.js';
import type { ListBillingAttachmentUsageInput } from './list-billing-attachment-usage.input.js';
import type { ListBillingAttachmentUsageOutput } from './list-billing-attachment-usage.output.js';

/** Lists verified attachment usage states within a fixed organization snapshot fence. */
export class ListBillingAttachmentUsage {
  // #region Constructor
  /** Receives the tenant reader and the configured cursor authenticator. */
  public constructor(
    private readonly reader: BillingAttachmentUsageReader,
    private readonly cursor: BillingAttachmentUsageCursor | null,
  ) {}
  // #endregion

  // #region Methods
  /** Reads one bounded page and seals a continuation only when another row exists. */
  public async execute(
    input: ListBillingAttachmentUsageInput,
  ): Promise<ListBillingAttachmentUsageOutput> {
    if (this.cursor === null) throw new BillingAttachmentUsageError('unavailable');
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError('Billing attachment usage page size must be 1 to 100.');
    }
    const position =
      input.cursor === null ? null : this.cursor.decode(input.organizationId, input.cursor);
    if (input.cursor !== null && position === null) {
      throw new BillingAttachmentUsageError('invalid-cursor');
    }

    const page = await this.reader.read(input.organizationId, position, input.limit + 1);
    const items = page.items.slice(0, input.limit);
    if (page.items.length <= input.limit) return { items, nextCursor: null };

    const last = items.at(-1);
    if (last === undefined || page.upperId === null) {
      throw new BillingAttachmentUsageError('unavailable');
    }
    return {
      items,
      nextCursor: this.cursor.encode(input.organizationId, {
        upperId: page.upperId,
        afterId: last.fileId,
      }),
    };
  }
  // #endregion
}
