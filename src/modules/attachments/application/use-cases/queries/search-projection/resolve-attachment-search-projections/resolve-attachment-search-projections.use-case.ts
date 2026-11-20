import type { AttachmentSearchProjectionReader } from '../../../../ports/outbound/persistence/search-projection/attachment-search-projection-reader.port.js';
import type { ResolveAttachmentSearchProjectionsInput } from './resolve-attachment-search-projections.input.js';
import type { ResolveAttachmentSearchProjectionsOutput } from './resolve-attachment-search-projections.output.js';

/** Resolves current Search projections for a tenant batch. */
export class ResolveAttachmentSearchProjections {
  // #region Constructor
  /** Binds the tenant reader. */
  public constructor(private readonly reader: AttachmentSearchProjectionReader) {}
  // #endregion

  // #region Methods
  /** Keeps the order of requested IDs in the returned decisions. */
  public async execute(
    input: ResolveAttachmentSearchProjectionsInput,
  ): Promise<ResolveAttachmentSearchProjectionsOutput> {
    return { results: await this.reader.resolve(input.organizationId, input.fileIds) };
  }
  // #endregion
}
