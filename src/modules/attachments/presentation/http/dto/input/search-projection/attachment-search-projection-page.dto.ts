import { ListAttachmentSearchProjectionsInternalQueryParams } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validates and bounds an attachment Search export request. */
export class AttachmentSearchProjectionPageDto extends zodDto(
  ListAttachmentSearchProjectionsInternalQueryParams.strict(),
) {}
