import type { NextFunction, Request, Response } from 'express';

/** Route families that can carry image capabilities or private binary responses. */
export const profileMediaPaths: string[] = [
  '/internal/v1/profile-media-uploads',
  '/internal/v1/avatars',
  '/internal/v1/organization/logo-assets',
];

/** Applies no-store before any authentication or validation of the matched routes. */
export function noStoreProfileMedia(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  response.setHeader('Cache-Control', 'no-store');
  next();
}

/** Marks parser errors produced before the NestJS controller middleware. */
export function noStoreProfileMediaErrors(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!response.headersSent) response.setHeader('Cache-Control', 'no-store');
  next(error);
}
