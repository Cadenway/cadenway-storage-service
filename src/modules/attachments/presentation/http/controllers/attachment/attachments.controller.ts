import { createHash } from 'node:crypto';

import {
  CompleteTaskAttachmentUploadInternalResponse,
  DeleteTaskAttachmentInternalHeader,
  GetTaskAttachmentDownloadInternalResponse,
  GetTaskAttachmentInternalResponse,
  ListLargestAttachmentsInternalResponse,
  ListTaskAttachmentsInternalResponse,
  StartTaskAttachmentUploadInternalHeader,
  StartTaskAttachmentUploadInternalResponse,
} from '@cadenway/contracts/validators/internal/storage-service';
import { InternalAccess } from '@cadenway/nest-common';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';

import { CompleteAttachmentUpload } from '../../../../application/use-cases/commands/attachment/complete-attachment-upload/complete-attachment-upload.use-case.js';
import { DeleteAttachment } from '../../../../application/use-cases/commands/attachment/delete-attachment/delete-attachment.use-case.js';
import { StartAttachmentUpload } from '../../../../application/use-cases/commands/attachment/start-attachment-upload/start-attachment-upload.use-case.js';
import { GetAttachmentDownload } from '../../../../application/use-cases/queries/attachment/get-attachment-download/get-attachment-download.use-case.js';
import { GetAttachment } from '../../../../application/use-cases/queries/attachment/get-attachment/get-attachment.use-case.js';
import { ListAttachments } from '../../../../application/use-cases/queries/attachment/list-attachments/list-attachments.use-case.js';
import { ListLargestAttachments } from '../../../../application/use-cases/queries/attachment/list-largest-attachments/list-largest-attachments.use-case.js';
import { AttachmentPageQuery } from '../../dto/input/attachment/attachment-page-query.dto.js';
import { AttachmentPath } from '../../dto/input/attachment/attachment-path.dto.js';
import { AttachmentTaskPath } from '../../dto/input/attachment/attachment-task-path.dto.js';
import { StartAttachmentBody } from '../../dto/input/attachment/start-attachment-body.dto.js';
import { answerAttachmentRefusals } from '../../errors/attachment/attachment.problem.js';
import { attachmentCaller } from '../../mappers/attachment/attachment-caller.mapper.js';
import { attachmentHeader } from '../../mappers/attachment/attachment-header.mapper.js';

/** Attachment transfers and metadata, scoped to the verified API gateway caller. */
@Controller('internal/v1')
@InternalAccess({ issuers: ['api-gateway'], actors: ['user'], organization: 'required' })
export class AttachmentsController {
  // #region Constructor
  /** Binds the attachment operations. */
  public constructor(
    private readonly listAttachments: ListAttachments,
    private readonly startUpload: StartAttachmentUpload,
    private readonly getAttachment: GetAttachment,
    private readonly deleteAttachment: DeleteAttachment,
    private readonly completeUpload: CompleteAttachmentUpload,
    private readonly downloadAttachment: GetAttachmentDownload,
    private readonly largestAttachments: ListLargestAttachments,
  ) {}
  // #endregion

  // #region Methods
  /** Lists ready files for the authorized task. */
  @Get('tasks/:taskKey/attachments')
  public async list(
    @Param() path: AttachmentTaskPath,
    @Query() query: AttachmentPageQuery,
  ): Promise<z.output<typeof ListTaskAttachmentsInternalResponse>> {
    const { organizationId } = attachmentCaller();
    const page = await answerAttachmentRefusals(() =>
      this.listAttachments.execute({
        organizationId,
        taskKey: path.taskKey,
        cursor: query.cursor ?? null,
        limit: query.limit,
      }),
    );
    return ListTaskAttachmentsInternalResponse.parse(page);
  }

  /** Reserves or replays an upload, without storing the capability in shared HTTP idempotency. */
  @Post('tasks/:taskKey/attachments')
  public async start(
    @Param() path: AttachmentTaskPath,
    @Body() body: StartAttachmentBody,
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<z.output<typeof StartTaskAttachmentUploadInternalResponse>> {
    const caller = attachmentCaller();
    const idempotencyKey = attachmentHeader(
      StartTaskAttachmentUploadInternalHeader.shape['Idempotency-Key'],
      rawIdempotencyKey,
      'Idempotency-Key',
    );
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([body.fileName, body.contentType.toLowerCase(), body.sizeBytes]),
        'utf8',
      )
      .digest('hex');
    const result = await answerAttachmentRefusals(() =>
      this.startUpload.execute({
        ...caller,
        taskKey: path.taskKey,
        fileName: body.fileName,
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
        fingerprint,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }),
    );
    const capability = StartTaskAttachmentUploadInternalResponse.parse(result.capability);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Location',
      `/internal/v1/tasks/${path.taskKey}/attachments/${capability.id}`,
    );
    return capability;
  }

  /** Returns ready attachment metadata with a strong entity tag. */
  @Get('tasks/:taskKey/attachments/:attachmentId')
  public async get(
    @Param() path: AttachmentPath,
    @Res({ passthrough: true }) response: Response,
  ): Promise<z.output<typeof GetTaskAttachmentInternalResponse>> {
    const { organizationId } = attachmentCaller();
    const result = await answerAttachmentRefusals(() =>
      this.getAttachment.execute({
        organizationId,
        taskKey: path.taskKey,
        attachmentId: path.attachmentId.toLowerCase(),
      }),
    );
    const attachment = GetTaskAttachmentInternalResponse.parse(result);
    response.setHeader('ETag', `"${String(attachment.version)}"`);
    return attachment;
  }

  /** Deletes a ready attachment, optionally conditional on its entity tag. */
  @Delete('tasks/:taskKey/attachments/:attachmentId')
  @HttpCode(204)
  public async delete(
    @Param() path: AttachmentPath,
    @Headers('if-match') rawIfMatch: unknown,
  ): Promise<void> {
    const caller = attachmentCaller();
    const ifMatch = attachmentHeader(
      DeleteTaskAttachmentInternalHeader.shape['If-Match'],
      rawIfMatch,
      'If-Match',
    );
    const expectedVersion = ifMatch === undefined ? undefined : Number(ifMatch.slice(1, -1));
    await answerAttachmentRefusals(() =>
      this.deleteAttachment.execute({
        ...caller,
        taskKey: path.taskKey,
        attachmentId: path.attachmentId.toLowerCase(),
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      }),
    );
  }

  /** Completes the verified uploader's reservation. */
  @Post('tasks/:taskKey/attachments/:attachmentId/completion')
  @HttpCode(200)
  public async complete(
    @Param() path: AttachmentPath,
    @Res({ passthrough: true }) response: Response,
  ): Promise<z.output<typeof CompleteTaskAttachmentUploadInternalResponse>> {
    const caller = attachmentCaller();
    const result = await answerAttachmentRefusals(() =>
      this.completeUpload.execute({
        ...caller,
        taskKey: path.taskKey,
        attachmentId: path.attachmentId.toLowerCase(),
      }),
    );
    const attachment = CompleteTaskAttachmentUploadInternalResponse.parse(result.attachment);
    response.setHeader('ETag', `"${String(attachment.version)}"`);
    return attachment;
  }

  /** Returns a temporary download capability without allowing HTTP caches to retain it. */
  @Get('tasks/:taskKey/attachments/:attachmentId/download')
  public async download(
    @Param() path: AttachmentPath,
    @Res({ passthrough: true }) response: Response,
  ): Promise<z.output<typeof GetTaskAttachmentDownloadInternalResponse>> {
    const { organizationId } = attachmentCaller();
    const result = await answerAttachmentRefusals(() =>
      this.downloadAttachment.execute({
        organizationId,
        taskKey: path.taskKey,
        attachmentId: path.attachmentId.toLowerCase(),
      }),
    );
    response.setHeader('Cache-Control', 'no-store');
    return GetTaskAttachmentDownloadInternalResponse.parse(result);
  }

  /** Lists the organization's largest files for the gateway's authorized quota workflow. */
  @Get('attachments/largest')
  public async largest(
    @Query() query: AttachmentPageQuery,
  ): Promise<z.output<typeof ListLargestAttachmentsInternalResponse>> {
    const { organizationId } = attachmentCaller();
    const page = await answerAttachmentRefusals(() =>
      this.largestAttachments.execute({
        organizationId,
        cursor: query.cursor ?? null,
        limit: query.limit,
      }),
    );
    return ListLargestAttachmentsInternalResponse.parse(page);
  }
  // #endregion
}
