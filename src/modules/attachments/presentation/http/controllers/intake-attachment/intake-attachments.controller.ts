import {
  CompleteIntakeAttachmentUploadInternalResponse,
  StartIntakeAttachmentUploadInternalResponse,
} from '@cadenway/contracts/validators/internal/storage-service';
import { InternalAccess, requireOrganizationId } from '@cadenway/nest-common';
import { Body, Controller, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';

import { CompleteIntakeAttachmentUpload } from '../../../../application/use-cases/commands/intake-attachment/complete-intake-attachment-upload/complete-intake-attachment-upload.use-case.js';
import { StartIntakeAttachmentUpload } from '../../../../application/use-cases/commands/intake-attachment/start-intake-attachment-upload/start-intake-attachment-upload.use-case.js';
import { IntakeAttachmentCompletionPath } from '../../dto/input/intake-attachment/intake-attachment-completion-path.dto.js';
import { IntakeAttachmentStartBody } from '../../dto/input/intake-attachment/intake-attachment-start-body.dto.js';
import { IntakeAttachmentStartPath } from '../../dto/input/intake-attachment/intake-attachment-start-path.dto.js';
import { answerIntakeAttachmentRefusals } from '../../errors/intake-attachment/intake-attachment.problem.js';

/** Handles intake transfers after the gateway obtains the authoritative Task allocation. */
@Controller('internal/v1/intake-publications/:publicationId/attachments')
@InternalAccess({ issuers: ['api-gateway'], actors: ['system'], organization: 'required' })
export class IntakeAttachmentsController {
  // #region Constructor
  /** Binds transfer signing and verification to the intake operations. */
  public constructor(
    private readonly startUpload: StartIntakeAttachmentUpload,
    private readonly completeUpload: CompleteIntakeAttachmentUpload,
  ) {}
  // #endregion

  // #region Methods
  /** Signs or replays an upload capability for the allocated reservation. */
  @Post()
  public async start(
    @Param() path: IntakeAttachmentStartPath,
    @Body() body: IntakeAttachmentStartBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<z.output<typeof StartIntakeAttachmentUploadInternalResponse>> {
    const organizationId = requireOrganizationId();
    const publicationId = path.publicationId.toLowerCase();
    const result = await answerIntakeAttachmentRefusals(() =>
      this.startUpload.execute({
        organizationId,
        publicationId,
        attachmentId: body.attachmentId.toLowerCase(),
        expiresAt: new Date(body.expiresAt),
        fileName: body.fileName,
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
      }),
    );
    const capability = StartIntakeAttachmentUploadInternalResponse.parse(result.capability);
    response.setHeader(
      'Location',
      `/internal/v1/intake-publications/${publicationId}/attachments/${capability.id}`,
    );
    return capability;
  }

  /** Acknowledges the verified reservation without returning file metadata. */
  @Post(':attachmentId/completion')
  @HttpCode(200)
  public async complete(
    @Param() path: IntakeAttachmentCompletionPath,
  ): Promise<z.output<typeof CompleteIntakeAttachmentUploadInternalResponse>> {
    const organizationId = requireOrganizationId();
    const result = await answerIntakeAttachmentRefusals(() =>
      this.completeUpload.execute({
        organizationId,
        publicationId: path.publicationId.toLowerCase(),
        attachmentId: path.attachmentId.toLowerCase(),
      }),
    );
    return CompleteIntakeAttachmentUploadInternalResponse.parse({ id: result.id });
  }
  // #endregion
}
