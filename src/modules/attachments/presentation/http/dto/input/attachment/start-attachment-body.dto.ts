import { StartTaskAttachmentUploadInternalBody } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validated closed upload metadata. */
export class StartAttachmentBody extends zodDto(StartTaskAttachmentUploadInternalBody) {}
