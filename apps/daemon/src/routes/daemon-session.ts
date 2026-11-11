import net from 'node:net';
import type { Express, Request } from 'express';

import { apiTokenEquals } from '../api-token-auth.js';
import { pruneAttemptBuckets } from '../http/attempt-buckets.js';
import { isLoopbackPeerAddress } from '../http/local-daemon-request.js';
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

/** How many new client buckets may accumulate before the table is swept. */
const SWEEP_EVERY_INSERTS = 256;

/**
 * Hard ceiling on tracked clients. Far above any real deployment, low enough
 * that a distributed attacker cannot use the login surface as an allocator.
 */
const MAX_TRACKED_CLIENTS = 10_000;

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
  let insertsSinceSweep = 0;

  /**
   * A bucket expires logically when its window passes, but the entry stayed in
   * the map forever: rotating the client address (free with IPv6 privacy
   * addresses) added one permanent entry per attempt to a login endpoint that
   * anyone can reach. Sweep every few hundred new buckets — cheap amortised,
   * and it keeps a public surface from growing the process without bound.
   */
  const noteAttempt = (now: number): void => {
    insertsSinceSweep += 1;
    if (insertsSinceSweep < SWEEP_EVERY_INSERTS) return;
    insertsSinceSweep = 0;
    pruneAttemptBuckets(attempts, now, MAX_TRACKED_CLIENTS);
  };

  /**
   * Behind a reverse proxy every browser arrives from the proxy's socket
   * address, so a bucket keyed on it turns ten typos into a five-minute outage
   * for everyone — and an unauthenticated login DoS into ten requests. Trust
   * `X-Forwarded-For` only from a peer that can plausibly be the proxy (loopback
   * or an explicit `OD_TRUSTED_PROXIES` entry), and read the address the proxy
   * *appended*: everything to its left is client-supplied.
   */
  const forwardedClient = (req: Request): string | null => {
    const peer = String(req.socket?.remoteAddress ?? '');
    const trustedProxies = String(env.OD_TRUSTED_PROXIES ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!isLoopbackPeerAddress(peer) && !trustedProxies.includes(peer)) return null;
    const header = req.get('x-forwarded-for');
    if (!header) return null;
    const entries = header.split(',').map((entry) => entry.trim()).filter(Boolean);
    const last = entries.at(-1)?.replace(/^\[|\]$/g, '');
    return last && net.isIP(last) ? last : null;
  };

  const clientKey = (req: Request): string =>
    forwardedClient(req) ?? String(req.socket?.remoteAddress ?? req.ip ?? 'unknown');

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
      noteAttempt(now);
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
