import { ListTaskAttachmentsInternalQueryParams } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validated and bounded attachment page. */
export class AttachmentPageQuery extends zodDto(ListTaskAttachmentsInternalQueryParams) {}
