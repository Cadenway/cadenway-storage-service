import { ProblemException } from '@cadenway/nest-common';

import { answerAttachmentRefusals } from '../attachment/attachment.problem.js';

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

function durableStateUnavailable(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      (/^08[0-9A-Z]{3}$/u.test(current.code) || transientDatabaseCodes.has(current.code))
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** Answers stable refusals and hides details of transient durable state failures. */
export async function answerIntakeAttachmentRefusals<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await answerAttachmentRefusals(work);
  } catch (error) {
    if (durableStateUnavailable(error)) {
      throw new ProblemException({ status: 503, code: 'storage.unavailable' });
    }
    throw error;
  }
}
