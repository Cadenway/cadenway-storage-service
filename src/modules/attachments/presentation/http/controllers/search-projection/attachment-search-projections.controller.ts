import {
  ListAttachmentSearchProjectionsInternalResponse,
  ResolveAttachmentSearchProjectionsInternalResponse,
} from '@cadenway/contracts/validators/internal/storage-service';
import {
  getOrganizationContext,
  InternalAccess,
  ProblemException,
  requireOrganizationId,
} from '@cadenway/nest-common';
import { Body, Controller, Get, Header, HttpCode, Post, Query } from '@nestjs/common';
import type { z } from 'zod';

import { ListAttachmentSearchProjections } from '../../../../application/use-cases/queries/search-projection/list-attachment-search-projections/list-attachment-search-projections.use-case.js';
import { ResolveAttachmentSearchProjections } from '../../../../application/use-cases/queries/search-projection/resolve-attachment-search-projections/resolve-attachment-search-projections.use-case.js';
import { AttachmentSearchProjectionPageDto } from '../../dto/input/search-projection/attachment-search-projection-page.dto.js';
import { ResolveAttachmentSearchProjectionsBody } from '../../dto/input/search-projection/resolve-attachment-search-projections-body.dto.js';
import { answerAttachmentSearchProjection } from '../../errors/search-projection/attachment-search-projection.problem.js';

function searchOrganizationId(): string {
  const actor = getOrganizationContext()?.actor;
  if (actor?.type !== 'system' || actor.id !== 'search-service') {
    throw new ProblemException({ status: 403, code: 'auth.actor-not-allowed' });
  }
  return requireOrganizationId();
}

/** Exposes only attachment Search metadata to the verified Search system actor. */
@Controller('internal/v1/attachment-search-projections')
@InternalAccess({ issuers: ['search-service'], actors: ['system'], organization: 'required' })
export class AttachmentSearchProjectionsController {
  // #region Constructor
  /** Binds the two read operations. */
  public constructor(
    private readonly listProjections: ListAttachmentSearchProjections,
    private readonly resolveProjections: ResolveAttachmentSearchProjections,
  ) {}
  // #endregion

  // #region Methods
  /** Exports one ascending, tenant-scoped page of ready projections. */
  @Get()
  @Header('Cache-Control', 'private, no-store')
  public list(
    @Query() query: AttachmentSearchProjectionPageDto,
  ): Promise<z.output<typeof ListAttachmentSearchProjectionsInternalResponse>> {
    const organizationId = searchOrganizationId();
    return answerAttachmentSearchProjection(async () =>
      ListAttachmentSearchProjectionsInternalResponse.parse(
        await this.listProjections.execute({
          organizationId,
          cursor: query.cursor ?? null,
          limit: query.limit,
        }),
      ),
    );
  }

  /** Returns current decisions in the order of the input IDs. */
  @Post('resolve')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  public resolve(
    @Body() body: ResolveAttachmentSearchProjectionsBody,
  ): Promise<z.output<typeof ResolveAttachmentSearchProjectionsInternalResponse>> {
    const organizationId = searchOrganizationId();
    return answerAttachmentSearchProjection(async () =>
      ResolveAttachmentSearchProjectionsInternalResponse.parse(
        await this.resolveProjections.execute({
          organizationId,
          fileIds: body.fileIds.map((id) => id.toLowerCase()),
        }),
      ),
    );
  }
  // #endregion
}
