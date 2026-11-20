import { ProblemException } from '@cadenway/nest-common';

import { AttachmentSearchProjectionError } from '../../../../application/models/search-projection/attachment-search-projection-error.model.js';

/** Reports stable problems without exposing cursors, file names or persistence details. */
export async function answerAttachmentSearchProjection<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error: unknown) {
    if (error instanceof AttachmentSearchProjectionError && error.reason === 'invalid-cursor') {
      throw new ProblemException({
        status: 400,
        code: 'request.invalid',
        details: {
          issues: [
            {
              in: 'query',
              path: 'cursor',
              code: 'invalid_cursor',
              message: 'Expected a continuation from this attachment Search export.',
            },
          ],
        },
      });
    }
    throw new ProblemException({ status: 503, code: 'storage.unavailable' });
  }
}
