import { CONFIG } from '@cadenway/nest-common';
import { TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { Provider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { ListAttachmentSearchProjections } from '../../../../application/use-cases/queries/search-projection/list-attachment-search-projections/list-attachment-search-projections.use-case.js';
import { ResolveAttachmentSearchProjections } from '../../../../application/use-cases/queries/search-projection/resolve-attachment-search-projections/resolve-attachment-search-projections.use-case.js';
import { HmacAttachmentSearchProjectionCursor } from '../../../../infrastructure/adapters/search-projection/hmac-attachment-search-projection-cursor.adapter.js';
import { DrizzleAttachmentSearchProjectionReader } from '../../../../infrastructure/persistence/drizzle/repositories/search-projection/drizzle-attachment-search-projection-reader.repository.js';

/** Binds the Search operations to the owned attachment reader and stable cursor signer. */
export const attachmentSearchProjectionProviders: readonly Provider[] = [
  {
    provide: DrizzleAttachmentSearchProjectionReader,
    inject: [TenantTransactionRunner],
    useFactory: (tenant: TenantTransactionRunner) =>
      new DrizzleAttachmentSearchProjectionReader(tenant),
  },
  {
    provide: ListAttachmentSearchProjections,
    inject: [DrizzleAttachmentSearchProjectionReader, CONFIG],
    useFactory: (
      reader: DrizzleAttachmentSearchProjectionReader,
      config: AppConfig,
    ): ListAttachmentSearchProjections => {
      const key = config.SEARCH_PROJECTION_CURSOR_SECRET;
      const cursor =
        key === undefined
          ? null
          : new HmacAttachmentSearchProjectionCursor(Buffer.from(key, 'base64url'));
      return new ListAttachmentSearchProjections(reader, cursor);
    },
  },
  {
    provide: ResolveAttachmentSearchProjections,
    inject: [DrizzleAttachmentSearchProjectionReader],
    useFactory: (reader: DrizzleAttachmentSearchProjectionReader) =>
      new ResolveAttachmentSearchProjections(reader),
  },
];
