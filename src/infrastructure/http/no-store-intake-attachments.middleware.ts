import type { NextFunction, Request, Response } from 'express';

/** Prevents caching of all responses from intake attachment routes, including refused requests. */
export function noStoreIntakeAttachments(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  response.setHeader('Cache-Control', 'no-store');
  next();
}

/** Adds the same cache policy when JSON parsing fails before the normal route middleware. */
export function noStoreIntakeAttachmentParserErrors(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  noStoreIntakeAttachments(request, response, () => {
    next(error);
  });
}
