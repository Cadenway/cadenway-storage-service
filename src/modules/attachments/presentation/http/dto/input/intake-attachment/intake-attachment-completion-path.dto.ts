import { CompleteIntakeAttachmentUploadInternalParams } from '@cadenway/contracts/validators/internal/storage-service';
import { zodDto } from '@cadenway/nest-common';

/** Validates the Task-allocated publication and attachment identifiers for verification. */
export class IntakeAttachmentCompletionPath extends zodDto(
  CompleteIntakeAttachmentUploadInternalParams,
) {}
