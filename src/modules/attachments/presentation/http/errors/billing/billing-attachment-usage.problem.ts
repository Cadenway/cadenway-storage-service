import { ProblemException } from '@cadenway/nest-common';

import { BillingAttachmentUsageError } from '../../../../application/models/billing/billing-attachment-usage-error.model.js';

/** Maps export failures without disclosing cursors or persistence details. */
export async function answerBillingAttachmentUsage<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error: unknown) {
    if (error instanceof BillingAttachmentUsageError && error.reason === 'invalid-cursor') {
      throw new ProblemException({
        status: 400,
        code: 'request.invalid',
        details: {
          issues: [
            {
              in: 'query',
              path: 'cursor',
              code: 'invalid_cursor',
              message: 'Expected a continuation from this Billing attachment usage export.',
            },
          ],
        },
      });
    }
    throw new ProblemException({ status: 503, code: 'storage.unavailable' });
  }
}
