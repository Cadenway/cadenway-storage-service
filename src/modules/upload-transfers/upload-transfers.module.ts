import {
  CONFIG,
  Logger,
  LoggingModule,
  ProblemFilter,
  RouteNameInterceptor,
} from '@cadenway/nest-common';
import { SystemTransactionRunner } from '@cadenway/nest-common/database';
import { Module } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import type { AppConfig } from '../../config/app-config.js';
import { ReceiveUploadTransfer } from './application/use-cases/commands/transfers/receive-upload-transfer/receive-upload-transfer.use-case.js';
import { LocalUploadTransfer } from './infrastructure/adapters/object-storage/local-upload-transfer.adapter.js';
import {
  LocalUploadTransferController,
  LocalUploadTransferMultipart,
} from './presentation/http/controllers/transfers/local-upload-transfer.controller.js';

const localUploadTransferPort = 3016;

/** Composition root for the local browser listener, with no internal API controllers. */
@Module({
  controllers: [LocalUploadTransferController],
  providers: [
    LocalUploadTransferMultipart,
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_INTERCEPTOR, useClass: RouteNameInterceptor },
  ],
})
class LocalUploadTransferHttpModule {}

/** Creates the isolated HTTP application with the parent service's transfer operation. */
export async function createLocalUploadTransferApplication(
  config: Readonly<AppConfig>,
  transfer: ReceiveUploadTransfer,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    {
      module: LocalUploadTransferHttpModule,
      imports: [
        LoggingModule.forRoot({
          service: 'storage-service',
          level: config.LOG_LEVEL,
          pretty: config.LOG_PRETTY,
          environment: config.NODE_ENV,
        }),
      ],
      providers: [{ provide: ReceiveUploadTransfer, useValue: transfer }],
    },
    { bodyParser: false, bufferLogs: true, abortOnError: false },
  );
  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  return app;
}

/** Owns the opt-in local listener without adding process signal handlers. */
class LocalUploadTransferListener implements OnApplicationBootstrap, BeforeApplicationShutdown {
  // #region Properties
  /** Child HTTP application owned by the parent Storage lifecycle. */
  private listener: NestExpressApplication | undefined;
  // #endregion

  // #region Constructor
  /** Reuses the admission operation from the internal service's container. */
  public constructor(
    private readonly config: Readonly<AppConfig>,
    private readonly transfer: ReceiveUploadTransfer,
  ) {}
  // #endregion

  // #region Methods
  /** Starts the dedicated listener only for a validated browser-local upload URL. */
  public async onApplicationBootstrap(): Promise<void> {
    if (this.config.objectStorage?.uploadTransferUrl === undefined) return;
    this.listener = await createLocalUploadTransferApplication(this.config, this.transfer);
    try {
      await this.listener.listen(localUploadTransferPort);
    } catch (error) {
      await this.beforeApplicationShutdown();
      throw error;
    }
  }

  /** Drains the browser listener before the parent destroys the shared database pool. */
  public async beforeApplicationShutdown(): Promise<void> {
    const listener = this.listener;
    this.listener = undefined;
    await listener?.close();
  }
  // #endregion
}

/** Owns the local browser transport and the admission ledger for one-shot staging writes. */
@Module({
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
    {
      provide: LocalUploadTransferListener,
      inject: [CONFIG, ReceiveUploadTransfer],
      useFactory: (
        config: Readonly<AppConfig>,
        transfer: ReceiveUploadTransfer,
      ): LocalUploadTransferListener => new LocalUploadTransferListener(config, transfer),
    },
  ],
})
export class UploadTransfersModule {}
