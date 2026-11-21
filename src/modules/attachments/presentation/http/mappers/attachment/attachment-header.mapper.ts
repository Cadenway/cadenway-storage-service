import { ProblemException } from '@cadenway/nest-common';
import type { z } from 'zod';

/** Validates a single optional header using its published schema. */
export function attachmentHeader(
  schema: z.ZodType<string | undefined>,
  value: unknown,
  name: string,
): string | undefined {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ProblemException({
      status: 400,
      code: 'request.invalid',
      details: {
        issues: result.error.issues.map((issue) => ({
          in: 'header',
          path: name,
          code: issue.code,
          message: issue.message,
        })),
      },
    });
  }
  return result.data;
}
