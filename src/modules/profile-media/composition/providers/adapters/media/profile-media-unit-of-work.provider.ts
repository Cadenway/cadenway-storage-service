import { CONFIG } from '@cadenway/nest-common';
import { SystemTransactionRunner, TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { ProfileMediaUnavailable } from '../../../../application/models/media/profile-media-unavailable.model.js';
import type { ProfileMediaUnitOfWork } from '../../../../application/ports/outbound/transactions/media/profile-media-unit-of-work.port.js';
import { AesProfileMediaReceiptCipher } from '../../../../infrastructure/adapters/crypto/aes-profile-media-receipt-cipher.adapter.js';
import type { ProfileMediaReceiptCipher } from '../../../../infrastructure/persistence/drizzle/repositories/media/drizzle-profile-media-transaction.repository.js';
import { DrizzleProfileMediaUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/media/drizzle-profile-media.unit-of-work.js';
import { PROFILE_MEDIA_UNIT_OF_WORK } from '../../../tokens/media/profile-media.token.js';

function receiptCipherUnavailable(): never {
  throw new ProfileMediaUnavailable();
}

/** Joins account or tenant work with the immutable encrypted receipt binding. */
export const profileMediaUnitOfWorkProvider: FactoryProvider<ProfileMediaUnitOfWork> = {
  provide: PROFILE_MEDIA_UNIT_OF_WORK,
  inject: [SystemTransactionRunner, TenantTransactionRunner, CONFIG],
  useFactory: (
    system: SystemTransactionRunner,
    tenant: TenantTransactionRunner,
    { objectStorage }: Readonly<AppConfig>,
  ): ProfileMediaUnitOfWork => {
    const keys = objectStorage?.receiptKeys;
    const cipher: ProfileMediaReceiptCipher =
      keys === undefined
        ? { seal: receiptCipherUnavailable, open: receiptCipherUnavailable }
        : new AesProfileMediaReceiptCipher(keys.activeKeyId, keys.keys);
    return new DrizzleProfileMediaUnitOfWork(system, tenant, cipher);
  },
};
