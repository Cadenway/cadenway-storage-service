import { ProblemException } from '@cadenway/nest-common';

import { AttachmentRefusal } from '../../../../application/models/attachment/attachment-refusal.model.js';
import { AttachmentError } from '../../../../application/models/attachment/attachment-domain-error.model.js';
import { AttachmentObjectStorageError } from '../../../../application/models/attachment/attachment-object-storage-error.model.js';

/** Maps expected attachment refusals without exposing metadata or object locations. */
export async function answerAttachmentRefusals<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    if (error instanceof AttachmentObjectStorageError) {
      throw new ProblemException({ status: 503, code: 'storage.unavailable' });
    }
    if (error instanceof AttachmentRefusal) {
      switch (error.reason) {
        case 'not-found':
          throw new ProblemException({ status: 404, code: 'attachment.not-found' });
        case 'upload-not-ready':
          throw new ProblemException({ status: 409, code: 'attachment.upload-not-ready' });
        case 'version-mismatch':
          throw new ProblemException({ status: 412, code: 'request.version-mismatch' });
        case 'request-in-progress':
          throw new ProblemException({ status: 409, code: 'idempotency.request-in-progress' });
        case 'idempotency-key-reused':
          throw new ProblemException({ status: 422, code: 'idempotency.key-reused' });
      }
    }
    if (error instanceof AttachmentError) {
      switch (error.reason) {
        case 'file-too-large':
        case 'upload-metadata-mismatch':
          throw new ProblemException({ status: 422, code: `attachment.${error.reason}` });
        case 'upload-expired':
        case 'upload-not-ready':
          throw new ProblemException({ status: 409, code: `attachment.${error.reason}` });
        case 'attachment-deleted':
          throw new ProblemException({ status: 404, code: 'attachment.not-found' });
      }
    }
    throw error;
  }
}
