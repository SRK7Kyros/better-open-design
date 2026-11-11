import type { Express, Request } from 'express';

import { apiTokenEquals } from '../api-token-auth.js';
import {
  clearSessionCookie,
  daemonSessionMatches,
  mintDaemonSession,
  readCookie,
  requestIsCrossSite,
  requestIsHttps,
  SESSION_COOKIE_NAME,
  sessionCookieShapeAvailable,
  sessionTtlMs,
  serializeSessionCookie,
} from '../http/session-cookie.js';

export interface RegisterDaemonSessionRoutesDeps {
  /** The configured `OD_API_TOKEN`; empty when the daemon is unauthenticated. */
  apiToken: string;
  /** `apiToken.length > 0 && !OD_DISABLE_API_AUTH`. */
  apiTokenAuthEnabled: boolean;
  /** Whether the caller is already trusted without credentials (loopback). */
  isTrustedPeer: (req: Request) => boolean;
  /** True when the request carries a valid Bearer/Basic credential. */
  hasValidAuthorization: (req: Request) => boolean;
  env?: NodeJS.ProcessEnv;
}

const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;

/**
 * Three endpoints, all reachable without credentials (they are what a browser
 * uses to obtain them):
 *
 * - `GET  /api/auth/session`           → `{ required, authenticated }`, the
 *   probe the web shell uses to decide whether to show the unlock screen;
 * - `POST /api/auth/session`           → exchange the token for the cookie;
 * - `DELETE /api/auth/session`         → drop the cookie.
 *
 * The token never appears in a URL, and the cookie is HttpOnly so a script in
 * the page cannot read it back.
 */
export function registerDaemonSessionRoutes(
  app: Express,
  deps: RegisterDaemonSessionRoutesDeps,
): void {
  const env = deps.env ?? process.env;
  const attempts = new Map<string, { count: number; resetAt: number }>();

  const clientKey = (req: Request): string =>
    String(req.socket?.remoteAddress ?? req.ip ?? 'unknown');

  const tooManyAttempts = (req: Request): boolean => {
    const bucket = attempts.get(clientKey(req));
    if (!bucket || bucket.resetAt <= Date.now()) return false;
    return bucket.count >= MAX_ATTEMPTS;
  };

  const recordFailure = (req: Request): void => {
    const key = clientKey(req);
    const now = Date.now();
    const bucket = attempts.get(key);
    if (!bucket || bucket.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
      return;
    }
    bucket.count += 1;
  };

  app.get('/api/auth/session', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      required: deps.apiTokenAuthEnabled,
      authenticated:
        !deps.apiTokenAuthEnabled
        || deps.isTrustedPeer(req)
        || deps.hasValidAuthorization(req)
        || daemonSessionMatches(
          readCookie(req.get('cookie'), SESSION_COOKIE_NAME),
          deps.apiToken,
        ),
    });
  });

  app.post('/api/auth/session', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.apiTokenAuthEnabled) {
      return res.status(409).json({
        error: {
          code: 'API_AUTH_DISABLED',
          message: 'This daemon does not require a token.',
        },
      });
    }
    if (tooManyAttempts(req)) {
      return res.status(429).json({
        error: {
          code: 'TOO_MANY_ATTEMPTS',
          message: 'Too many unlock attempts. Try again in a few minutes.',
        },
      });
    }

    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!deps.hasValidAuthorization(req) && !apiTokenEquals(token, deps.apiToken)) {
      recordFailure(req);
      return res.status(401).json({
        error: { code: 'API_TOKEN_INVALID', message: 'That token was rejected.' },
      });
    }

    const crossSite = requestIsCrossSite(req.get('sec-fetch-site'));
    const secure = requestIsHttps(req.get('x-forwarded-proto'), req.secure);
    if (!sessionCookieShapeAvailable(crossSite, secure)) {
      return res.status(400).json({
        error: {
          code: 'SESSION_COOKIE_UNSUPPORTED',
          message: 'A cross-site session cookie requires HTTPS. Serve this deployment over TLS, or put both origins behind one host.',
        },
      });
    }

    const ttlMs = sessionTtlMs(env);
    const session = mintDaemonSession(deps.apiToken, { ttlMs });
    res.setHeader(
      'Set-Cookie',
      serializeSessionCookie({
        value: session.value,
        maxAgeSeconds: Math.floor(ttlMs / 1000),
        secure,
        crossSite,
      }),
    );
    res.json({ ok: true, expiresAt: new Date(session.expiresAt).toISOString() });
  });

  app.delete('/api/auth/session', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Set-Cookie',
      clearSessionCookie({
        secure: requestIsHttps(req.get('x-forwarded-proto'), req.secure),
        crossSite: requestIsCrossSite(req.get('sec-fetch-site')),
      }),
    );
    res.json({ ok: true });
  });
}
