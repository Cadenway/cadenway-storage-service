import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

const projectionPaths =
  /^\/internal\/v1\/(?:attachment-search-projections(?:\/resolve)?|billing-attachment-usage)\/?$/iu;

/** Applies the projection cache policy to route responses and errors from the shared parser. */
export function configureSearchProjectionNoStore(app: Pick<NestExpressApplication, 'use'>): void {
  app.use(projectionPaths, (request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'private, no-store');
    // Each export consumes a fresh projection page, including its continuation.
    if (request.method === 'GET' || request.method === 'HEAD') {
      delete request.headers['if-none-match'];
      delete request.headers['if-modified-since'];
    }
    next();
  });
  app.use(
    projectionPaths,
    (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
      if (!response.headersSent) response.setHeader('Cache-Control', 'private, no-store');
      next(error);
    },
  );
}
