import { ListTaskAttachmentsInternalParams } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validated stable task key. */
export class AttachmentTaskPath extends zodDto(ListTaskAttachmentsInternalParams) {}
