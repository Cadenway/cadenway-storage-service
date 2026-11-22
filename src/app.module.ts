import { CONFIG, ConfigModule, HealthModule, postgresIndicator } from '@cadenway/nest-common';
import type { PostgresProbe } from '@cadenway/nest-common';
import { DATABASE_POOL, DatabaseModule } from '@cadenway/nest-common/database';
import { JobsRuntimeModule } from '@cadenway/nest-jobs/runtime';
import {
  MessagingConnection,
  MessagingModule,
  messagingHealthIndicator,
} from '@cadenway/nest-messaging';
import { OutboxModule } from '@cadenway/nest-messaging/outbox';
import { Module } from '@nestjs/common';

import { appConfigSchema } from './config/app-config.js';
import type { AppConfig } from './config/app-config.js';
import { jobQueues } from './config/job-queues.js';
import { AttachmentsModule } from './modules/attachments/attachments.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { ProfileMediaModule } from './modules/profile-media/profile-media.module.js';
import { UploadTransfersModule } from './modules/upload-transfers/upload-transfers.module.js';

/**
 * Class AppModule
 *
 * @description
 * Root module of the service. `createApplication` of `@cadenway/nest-common` wraps it with the
 * logs, the `application/problem+json` errors, the validation pipe, the internal token guard and
 * the other shared formats; this module declares what the service itself depends on. Importing it
 * reads no configuration: every module below is built when the application is created.
 *
 * - `ConfigModule` (`eager: false`): the environment is validated against `appConfigSchema` when
 *   the application is created and provided as `CONFIG`; an invalid one makes `createApplication`
 *   reject with the `ConfigError`, which `runApplication` writes as one line.
 * - `DatabaseModule`: the pool of this service's own database, opened as the application role of
 *   `DATABASE_URL`, the tenant and system transaction runners, and the `Idempotency-Key`
 *   interceptor for the routes marked `@Idempotent()`. The pool closes on shutdown.
 * - `MessagingModule`: the NATS connection of the `storage` user, with the inbox prefix
 *   `_INBOX.storage` the broker requires. The creation waits for the first connection, then checks
 *   that the `EVENTS` stream exists: cadenway-ops creates the streams (`manageStreams: false`), and
 *   only notification-service runs the dead-letter worker. Storage publishes attachment lifecycle
 *   and verification facts. Attachments consumes Task purge and intake decisions. Profile Media
 *   consumes authoritative Identity and Organization media decisions.
 * - `OutboxModule`: the outbox writer, the PostgreSQL deduplicator and the relay, which polls
 *   `outbox_events` every second in a system transaction and publishes the pending rows. It runs in
 *   every replica; `for update skip locked` keeps two of them from publishing the same row.
 * - `JobsRuntimeModule`: the scheduler and worker for cleanup owned by this service, using the
 *   pg-boss schema provisioned by the migrator.
 * - `HealthModule`: `GET /health/live` answers as soon as the process runs; `GET /health/ready`
 *   answers 503 while PostgreSQL or NATS does not answer within 1 second, and from the start of a
 *   shutdown. Both probes are exempt from the internal token. All other routes on this application
 *   require an internal token. The opt-in local upload transport has a separate listener.
 *   `shutdownDelayMs` is 0: nothing that routes to this internal service reads its readiness.
 *   Callers reach it through the Docker DNS of the `internal` network, which keeps returning a
 *   stopping container until it exits, whatever its health (checked on Docker 28.2), and the GitOps
 *   agent only waits for the new container to be healthy before it stops the old one. A delay would
 *   lengthen every stop, under the 10 second default grace period of Docker, without moving any
 *   request away; set it above the probe interval of a proxy if one ever routes on readiness.
 * - `PlatformModule`: the owner of the kit tables in the migrations of the service.
 *
 * Business modules under `src/modules/` are registered here as they are created.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ schema: appConfigSchema, eager: false }),
    DatabaseModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        connectionString: config.DATABASE_URL,
        applicationName: 'storage-service',
        idempotency: true,
        transactionMaxAttempts: config.DATABASE_TRANSACTION_MAX_ATTEMPTS,
      }),
    }),
    MessagingModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        service: 'storage-service',
        servers: config.NATS_URL,
        user: config.NATS_USER,
        password: config.NATS_PASSWORD,
        manageStreams: false,
        deadLetterWorker: false,
      }),
    }),
    OutboxModule.forRoot(),
    JobsRuntimeModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        connection: { connectionString: config.DATABASE_URL },
        queues: jobQueues,
        capabilities: ['worker', 'scheduler'],
        poolSize: 2,
        shutdownTimeoutMs: 8_000,
      }),
    }),
    HealthModule.forRootAsync({
      inject: [DATABASE_POOL, MessagingConnection],
      useFactory: (pool: PostgresProbe, connection: MessagingConnection) => ({
        indicators: [postgresIndicator(pool), messagingHealthIndicator(connection)],
        shutdownDelayMs: 0,
      }),
    }),
    PlatformModule,
    AttachmentsModule,
    ProfileMediaModule,
    UploadTransfersModule,
  ],
})
export class AppModule {}
