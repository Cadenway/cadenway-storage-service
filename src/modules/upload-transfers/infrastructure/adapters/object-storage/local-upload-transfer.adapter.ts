import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { type SystemTransactionRunner } from '@cadenway/nest-common/database';
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { sql } from 'drizzle-orm';

import type { AppConfig } from '../../../../../config/app-config.js';
import { UploadTransferTicket } from '../../../../../infrastructure/object-storage/upload-transfer-ticket.js';
import type { UploadTransferResult } from '../../../application/models/transfers/upload-transfer-result.model.js';
import type { UploadTransferFile } from '../../../application/models/transfers/upload-transfer.model.js';
import type { UploadTransfer } from '../../../application/ports/outbound/object-storage/transfers/upload-transfer.port.js';
import { maximumTransferBytes } from '../../../domain/policies/transfers/upload-transfer.policy.js';
import { uploadTransferUses } from '../../persistence/drizzle/schemas/transfers/upload-transfer-uses.schema.js';

/** Claims a staging key durably before dispatching a single SDK request with no retries. */
export class LocalUploadTransfer implements UploadTransfer {
  // #region Properties
  /** Server-side object store client with retries disabled. */
  private readonly client: S3Client | undefined;

  /** Verifier for this process's local authorization. */
  private readonly tickets: UploadTransferTicket | undefined;

  /** Fixed private destination bucket for all staged files. */
  private readonly bucket: string | undefined;
  // #endregion

  // #region Constructor
  /** Binds the system transaction runner and the explicitly configured staging destination. */
  public constructor(
    private readonly work: SystemTransactionRunner,
    storage: AppConfig['objectStorage'],
  ) {
    if (storage?.uploadTransferUrl === undefined) return;
    this.bucket = storage.bucket;
    this.tickets = new UploadTransferTicket(storage.uploadTransferUrl, storage.receiptKeys);
    this.client = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      forcePathStyle: storage.forcePathStyle,
      credentials: {
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      followRegionRedirects: false,
      maxAttempts: 1,
    });
  }
  // #endregion

  // #region Methods
  /** Releases any connections held by the object store SDK. */
  public onApplicationShutdown(): void {
    this.client?.destroy();
  }

  /** Rejects an invalid ticket before the multipart adapter allocates file storage. */
  public admitsFile(ticket: string, contentType: string): boolean {
    const authorization = this.tickets?.open(ticket);
    return (
      authorization !== null &&
      authorization !== undefined &&
      Date.parse(authorization.expiresAt) > Date.now() &&
      authorization.contentType === contentType
    );
  }

  /** Admits the exact authenticated file and dispatches one terminal attempt. */
  public async put(token: string, file: UploadTransferFile): Promise<UploadTransferResult> {
    const { client, bucket, tickets } = this;
    if (client === undefined || bucket === undefined || tickets === undefined) return 'unavailable';
    const authorization = tickets.open(token);
    if (
      file.size !== authorization?.sizeBytes ||
      file.size < 1 ||
      file.size > maximumTransferBytes ||
      file.mimetype !== authorization.contentType
    ) {
      return 'invalid';
    }

    const stagingDigest = createHash('sha256').update(authorization.key).digest('hex');
    try {
      // The DB is authoritative for ticket deadlines and admission across instances and restarts.
      const receipt = await this.work.run(async ({ db }) => {
        const { rows } = await db.execute<{ live: boolean; admitted: boolean }>(sql`
          with expired as (
            select staging_digest from ${uploadTransferUses}
            where retain_until <= statement_timestamp()
            order by retain_until, staging_digest limit 100 for update skip locked
          ), pruned as (
            delete from ${uploadTransferUses} using expired
            where ${uploadTransferUses.stagingDigest} = expired.staging_digest
          ), admitted as (
            insert into ${uploadTransferUses} (staging_digest, retain_until)
            select ${stagingDigest}, ${authorization.expiresAt}::timestamptz + interval '5 minutes'
            where ${authorization.expiresAt}::timestamptz > statement_timestamp()
            on conflict do nothing returning staging_digest
          )
          select ${authorization.expiresAt}::timestamptz > statement_timestamp() as live,
                 exists (select 1 from admitted) as admitted
        `);
        return rows[0];
      });
      if (receipt?.live !== true) return 'invalid';
      if (!receipt.admitted) return 'consumed';

      const remainingMs = Date.parse(authorization.expiresAt) - Date.now();
      if (remainingMs <= 0) return 'unavailable';
      const body = createReadStream(file.path);
      try {
        await context.with(suppressTracing(context.active()), () =>
          client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: authorization.key,
              Body: body,
              ContentLength: file.size,
              ContentType: authorization.contentType,
              IfNoneMatch: '*',
            }),
            { abortSignal: AbortSignal.timeout(Math.min(10_000, remainingMs)) },
          ),
        );
      } finally {
        body.destroy();
      }
      return 'stored';
    } catch {
      // An uncertain commit or storage result never releases the admission record.
      return 'unavailable';
    }
  }
  // #endregion
}
