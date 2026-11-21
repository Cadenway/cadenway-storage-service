import { StartIntakeAttachmentUploadInternalBody } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validates the allocated reservation and its declared metadata. */
export class IntakeAttachmentStartBody extends zodDto(StartIntakeAttachmentUploadInternalBody) {}
