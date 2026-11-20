import {
  prepareProfileMediaInternalResponseSizeBytesMax,
  PrepareProfileMediaInternalResponse,
  SignProfileMediaTransferInternalResponse,
} from '@cadenway/contracts/validators/internal/storage-service';
import type { SignProfileMediaTransferInternalBody } from '@cadenway/contracts/validators/internal/storage-service';
import {
  DEFAULT_REQUEST_BUDGET_MS,
  InternalAccess,
  ProblemException,
  remainingBudgetMs,
  requireOrganizationId,
} from '@cadenway/nest-common';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';

import { PrepareProfileMedia } from '../../../../application/use-cases/commands/media/prepare-profile-media/prepare-profile-media.use-case.js';
import { SignProfileMediaTransfer } from '../../../../application/use-cases/commands/media/sign-profile-media-transfer/sign-profile-media-transfer.use-case.js';
import { ReadProfileMedia } from '../../../../application/use-cases/queries/media/read-profile-media/read-profile-media.use-case.js';
import { AvatarImagePath } from '../../dto/input/media/avatar-image-path.dto.js';
import { AvatarImageQuery } from '../../dto/input/media/avatar-image-query.dto.js';
import { OrganizationLogoImagePath } from '../../dto/input/media/organization-logo-image-path.dto.js';
import { ProfileMediaPreparationBody } from '../../dto/input/media/profile-media-preparation-body.dto.js';
import { ProfileMediaPreparationPath } from '../../dto/input/media/profile-media-preparation-path.dto.js';
import { ProfileMediaTransferPath } from '../../dto/input/media/profile-media-transfer-path.dto.js';
import { answerProfileMediaRefusals } from '../../errors/media/profile-media.problem.js';
import {
  profileMediaAvatarOwner,
  profileMediaUploadCaller,
} from '../../mappers/media/profile-media-caller.mapper.js';
import { ProfileMediaTransferBodyPipe } from '../../validation/media/profile-media-transfer-body.pipe.js';

function mediaRequestSignal(): AbortSignal {
  const budget = remainingBudgetMs() ?? DEFAULT_REQUEST_BUDGET_MS;
  if (budget <= 0) {
    return AbortSignal.abort(
      new DOMException('The media request deadline expired.', 'TimeoutError'),
    );
  }
  return AbortSignal.timeout(Math.floor(budget));
}

/** Sends the bounded verified PNG directly so Express never adds an ETag or returns a 304. */
function writePng(response: Response, png: Buffer): void {
  if (png.byteLength === 0 || png.byteLength > prepareProfileMediaInternalResponseSizeBytesMax) {
    throw new ProblemException({ status: 503, code: 'storage.unavailable' });
  }
  response.status(200);
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Content-Type', 'image/png');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Length', String(png.byteLength));
  response.end(png);
}

/** Serves profile media only after authorization by the signed API gateway caller. */
@Controller('internal/v1')
@InternalAccess({ issuers: ['api-gateway'], actors: ['user'], organization: 'optional' })
export class ProfileMediaController {
  // #region Constructor
  /** Binds signing, derivative preparation, and private read operations. */
  public constructor(
    private readonly signTransfer: SignProfileMediaTransfer,
    private readonly prepareMedia: PrepareProfileMedia,
    private readonly readMedia: ReadProfileMedia,
  ) {}
  // #endregion

  // #region Methods
  /** Signs or replays only the exact declaration already authorized by the owner service. */
  @Post('profile-media-uploads/:uploadId/transfer')
  @HttpCode(200)
  public async transfer(
    @Param() path: ProfileMediaTransferPath,
    @Body(new ProfileMediaTransferBodyPipe())
    body: z.output<typeof SignProfileMediaTransferInternalBody>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<z.output<typeof SignProfileMediaTransferInternalResponse>> {
    const result = await answerProfileMediaRefusals(() =>
      this.signTransfer.execute({
        ...profileMediaUploadCaller(body.kind),
        uploadId: path.uploadId.toLowerCase(),
        expiresAt: new Date(body.expiresAt),
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
        signal: mediaRequestSignal(),
      }),
    );
    response.setHeader('Cache-Control', 'no-store');
    return SignProfileMediaTransferInternalResponse.parse(result.capability);
  }

  /** Returns only the metadata of the elected immutable candidate. */
  @Post('profile-media-uploads/:uploadId/preparation')
  @HttpCode(200)
  public async prepare(
    @Param() path: ProfileMediaPreparationPath,
    @Body() body: ProfileMediaPreparationBody,
  ): Promise<z.output<typeof PrepareProfileMediaInternalResponse>> {
    const result = await answerProfileMediaRefusals(() =>
      this.prepareMedia.execute({
        ...profileMediaUploadCaller(body.kind),
        uploadId: path.uploadId.toLowerCase(),
        signal: mediaRequestSignal(),
      }),
    );
    return PrepareProfileMediaInternalResponse.parse(result.preparation);
  }

  /** Reads an account avatar only for its own or a gateway-authorized directory reference. */
  @Get('avatars/:assetId')
  public async avatar(
    @Param() path: AvatarImagePath,
    @Query() query: AvatarImageQuery,
    @Res() response: Response,
  ): Promise<void> {
    const { png } = await answerProfileMediaRefusals(() =>
      this.readMedia.execute({
        owner: profileMediaAvatarOwner(query.ownerUserId),
        assetId: path.assetId.toLowerCase(),
        signal: mediaRequestSignal(),
      }),
    );
    writePng(response, png);
  }

  /** Reads the exact current logo reference in the signed organization's scope. */
  @Get('organization/logo-assets/:assetId')
  @InternalAccess({ organization: 'required' })
  public async organizationLogo(
    @Param() path: OrganizationLogoImagePath,
    @Res() response: Response,
  ): Promise<void> {
    const { png } = await answerProfileMediaRefusals(() =>
      this.readMedia.execute({
        owner: { kind: 'organization-logo', id: requireOrganizationId().toLowerCase() },
        assetId: path.assetId.toLowerCase(),
        signal: mediaRequestSignal(),
      }),
    );
    writePng(response, png);
  }
  // #endregion
}
