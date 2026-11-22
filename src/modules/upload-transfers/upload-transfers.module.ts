import { CONFIG } from '@cadenway/nest-common';
import { SystemTransactionRunner } from '@cadenway/nest-common/database';
import { Module } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { ReceiveUploadTransfer } from './application/use-cases/commands/transfers/receive-upload-transfer/receive-upload-transfer.use-case.js';
import { LocalUploadTransfer } from './infrastructure/adapters/object-storage/local-upload-transfer.adapter.js';
import {
  LocalUploadTransferController,
  LocalUploadTransferMultipart,
} from './presentation/http/controllers/transfers/local-upload-transfer.controller.js';

/** Owns the local browser transport and the admission ledger for one-shot staging writes. */
@Module({
  controllers: [LocalUploadTransferController],
  providers: [
    {
      provide: LocalUploadTransfer,
      inject: [SystemTransactionRunner, CONFIG],
      useFactory: (work: SystemTransactionRunner, config: AppConfig): LocalUploadTransfer =>
        new LocalUploadTransfer(work, config.objectStorage),
    },
    {
      provide: ReceiveUploadTransfer,
      inject: [LocalUploadTransfer],
      useFactory: (transfer: LocalUploadTransfer): ReceiveUploadTransfer =>
        new ReceiveUploadTransfer(transfer),
    },
    LocalUploadTransferMultipart,
  ],
})
export class UploadTransfersModule {}
