import { StartIntakeAttachmentUploadInternalParams } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validates the Task-allocated publication identifier for upload signing. */
export class IntakeAttachmentStartPath extends zodDto(StartIntakeAttachmentUploadInternalParams) {}
