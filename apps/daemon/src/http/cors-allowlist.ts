import type { NextFunction, Request, Response } from 'express';

/**
 * CORS responder for the daemon-owned paths, for operators who serve the web
 * build from a different origin than the daemon.
 *
 * The origin guard in `server.ts` already decides whether a browser origin may
 * *call* the API, but it never emits `Access-Control-Allow-Origin`, so a
 * browser at another origin reads a blocked response body and blocks the
 * request outright. This middleware closes that gap for the origins an operator
 * listed in `OD_ALLOWED_ORIGINS` and for nothing else: no wildcard, no
 * `Origin: null`, no reflection of an unlisted origin.
 *
 * Preflight is answered here because the API routes are registered with
 * `app.get`/`app.post` only — Express answers OPTIONS with 404, which a browser
 * reports as a CORS failure.
 */
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

const DEFAULT_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'Accept',
  'Last-Event-ID',
  'X-Requested-With',
].join(', ');

const EXPOSED_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Content-Disposition',
  'Cache-Control',
  'ETag',
  'Last-Event-ID',
  'X-Request-Id',
].join(', ');

export function createAllowedOriginCors(origins: readonly string[]) {
  const allowlist = new Set(origins);

  return function allowedOriginCors(req: Request, res: Response, next: NextFunction): void {
    const origin = req.get('origin');
    if (!origin || origin === 'null' || !allowlist.has(origin)) {
      next();
      return;
    }

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader(
        'Access-Control-Allow-Headers',
        req.get('access-control-request-headers') || DEFAULT_ALLOWED_HEADERS,
      );
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }

    next();
  };
}
