import { GetTaskAttachmentInternalParams } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validated stable task and attachment identifiers. */
export class AttachmentPath extends zodDto(GetTaskAttachmentInternalParams) {}
