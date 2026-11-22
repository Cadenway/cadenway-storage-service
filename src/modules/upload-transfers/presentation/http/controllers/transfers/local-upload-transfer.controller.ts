import { mkdtempSync } from 'node:fs';
import { rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIG, ProblemException, SkipInternalToken } from '@cadenway/nest-common';
import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Post,
  UploadedFile,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { finalize, type Observable } from 'rxjs';
import { z } from 'zod';

import {
  maximumTransferBytes,
  type UploadTransferFile,
} from '../../../../application/models/transfers/upload-transfer.model.js';
import { ReceiveUploadTransfer } from '../../../../application/use-cases/commands/transfers/receive-upload-transfer/receive-upload-transfer.use-case.js';

const transferFields = z.strictObject({ ticket: z.string() });

interface MultipartRequest {
  // #region Properties
  /** Form fields already decoded when the file part starts. */
  readonly body?: unknown;

  /** Bounded private file provided by the parser. */
  readonly file?: UploadTransferFile;
  // #endregion

  // #region Methods
  /** Terminates a transfer that exceeds its deadline. */
  destroy(): void;
  // #endregion
}

/** Bounds local file intake by elapsed time, disk usage and concurrent requests. */
@Injectable()
export class LocalUploadTransferMultipart {
  // #region Properties
  /** Private temporary directory created only in local transfer mode. */
  private readonly directory: string | undefined;

  /** Bounded multipart parser used only for the transfer entry point. */
  private readonly parser;

  /** Allocated intake slots, including requests awaiting temporary file removal. */
  private active = 0;
  // #endregion

  // #region Constructor
  /** Assigns a parser only when the operator configures a browser-local target. */
  public constructor(
    @Inject(CONFIG) config: Readonly<{ objectStorage?: { readonly uploadTransferUrl?: string } }>,
    @Inject(ReceiveUploadTransfer) transfer: ReceiveUploadTransfer,
  ) {
    if (config.objectStorage?.uploadTransferUrl === undefined) return;
    this.directory = mkdtempSync(join(tmpdir(), 'cadenway-upload-transfer-'));
    const Parser = FileInterceptor('file', {
      dest: this.directory,
      fileFilter: (request: MultipartRequest, file, next) => {
        const fields = transferFields.safeParse(request.body);
        if (!fields.success || !transfer.admitsFile(fields.data.ticket, file.mimetype)) {
          next(new Error('Invalid upload transfer'), false);
          return;
        }
        next(null, true);
      },
      limits: {
        fields: 1,
        fieldNameSize: 16,
        fieldSize: 550,
        files: 1,
        fileSize: maximumTransferBytes + 1,
        parts: 3,
        fieldNestingDepth: 0,
      },
    });
    this.parser = new Parser();
  }
  // #endregion

  // #region Methods
  /** Bounds both ingress and temporary disk consumption before calling the route. */
  public async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (this.parser === undefined) {
      throw new ProblemException({ status: 404, code: 'request.not-found' });
    }
    if (this.active >= 2) {
      throw new ProblemException({ status: 503, code: 'storage.unavailable' });
    }
    this.active += 1;
    const request = context.switchToHttp().getRequest<MultipartRequest>();
    const timer = setTimeout(() => {
      request.destroy();
    }, 30_000);
    try {
      const response = await this.parser.intercept(context, next);
      return response.pipe(
        finalize(() => {
          this.release(request);
        }),
      );
    } catch {
      this.release(request);
      throw new ProblemException({ status: 400, code: 'storage.upload-transfer-invalid' });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Removes the private spool directory once its requests have finished. */
  public async onModuleDestroy(): Promise<void> {
    if (this.directory !== undefined) await rmdir(this.directory).catch(() => undefined);
  }

  /** Erases the scoped file before freeing its intake slot. */
  private release(request: MultipartRequest): void {
    if (request.file === undefined) {
      this.active -= 1;
      return;
    }
    void unlink(request.file.path)
      .catch(() => undefined)
      .finally(() => {
        this.active -= 1;
      });
  }
  // #endregion
}

/** Receives the opaque form sent to the configured local upload target. */
@Controller('/internal/v1/upload-transfers')
export class LocalUploadTransferController {
  // #region Constructor
  /** Binds one local staged upload operation. */
  public constructor(
    @Inject(ReceiveUploadTransfer) private readonly transfer: ReceiveUploadTransfer,
  ) {}
  // #endregion

  // #region Methods
  /** Returns only the stable result of the one-shot staging operation. */
  @Post()
  @SkipInternalToken()
  @HttpCode(204)
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cache-Control', 'private, no-store')
  @UseInterceptors(LocalUploadTransferMultipart)
  public async receive(
    @Body() payload: unknown,
    @UploadedFile() file?: UploadTransferFile,
  ): Promise<void> {
    const fields = transferFields.safeParse(payload);
    if (!fields.success || file === undefined) {
      throw new ProblemException({ status: 400, code: 'storage.upload-transfer-invalid' });
    }
    const result = await this.transfer.execute(fields.data.ticket, file);
    switch (result) {
      case 'stored':
        return;
      case 'invalid':
        throw new ProblemException({ status: 400, code: 'storage.upload-transfer-invalid' });
      case 'consumed':
        throw new ProblemException({ status: 409, code: 'storage.upload-transfer-consumed' });
      case 'unavailable':
        throw new ProblemException({ status: 503, code: 'storage.unavailable' });
    }
  }
  // #endregion
}
