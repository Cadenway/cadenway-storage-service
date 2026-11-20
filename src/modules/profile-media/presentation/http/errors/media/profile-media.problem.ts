import { ProblemException } from '@cadenway/nest-common';

import { ProfileMediaError } from '../../../../application/models/media/profile-media-refusal.model.js';
import { ProfileMediaUnavailable } from '../../../../application/models/media/profile-media-unavailable.model.js';

const transientDatabaseCodes = new Set([
  '40001',
  '40P01',
  '53300',
  '55P03',
  '57P01',
  '57P02',
  '57P03',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
]);

function dependencyUnavailable(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (
      current instanceof ProfileMediaUnavailable ||
      current.name === 'TimeoutError' ||
      ('code' in current &&
        typeof current.code === 'string' &&
        (/^08[0-9A-Z]{3}$/u.test(current.code) || transientDatabaseCodes.has(current.code)))
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** Maps expected media refusals while keeping provider errors and private object details redacted. */
export async function answerProfileMediaRefusals<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (dependencyUnavailable(error)) {
      throw new ProblemException({ status: 503, code: 'storage.unavailable' });
    }
    if (error instanceof ProfileMediaError) {
      switch (error.reason) {
        case 'not-found':
          throw new ProblemException({ status: 404, code: 'media.not-found' });
        case 'upload-expired':
        case 'upload-not-ready':
        case 'upload-superseded':
          throw new ProblemException({ status: 409, code: `media.${error.reason}` });
        case 'request-in-progress':
          throw new ProblemException({ status: 409, code: 'idempotency.request-in-progress' });
        case 'file-too-large':
        case 'unsupported-type':
        case 'invalid-image':
          throw new ProblemException({ status: 422, code: `media.${error.reason}` });
        case 'key-reused':
          throw new ProblemException({ status: 422, code: 'idempotency.key-reused' });
        case 'invalid-identity':
        case 'invalid-state':
          throw new ProblemException({ status: 503, code: 'storage.unavailable' });
      }
    }
    throw error;
  }
}
