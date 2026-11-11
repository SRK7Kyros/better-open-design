import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Browser session for a token-protected daemon.
 *
 * The daemon authenticates `/api` with `OD_API_TOKEN`, which a browser cannot
 * supply: `fetch` has no credential concept beyond cookies, and `EventSource`,
 * `<img>` and `<iframe>` have no header surface at all. Pasting the token into
 * every call site is therefore impossible — the split-origin web build cannot
 * work without a browser-native credential.
 *
 * This module mints one: an HMAC of the expiry under the API token, carried in
 * an HttpOnly cookie. Nothing is stored server-side, so a daemon restart does
 * not log browsers out, and rotating `OD_API_TOKEN` invalidates every session
 * at once (the signing key changes). The value is derived, never the token
 * itself, so a leaked cookie does not leak the deployment secret.
 */

export const SESSION_COOKIE_NAME = 'od_session';
export const SESSION_ROUTE_PATH = '/auth/session';

const SESSION_VALUE_VERSION = 'v1';
const SESSION_COOKIE_PATH = '/';

export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sign(apiToken: string, payload: string): string {
  return createHmac('sha256', apiToken).update(payload).digest('base64url');
}

function secretsMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function sessionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.OD_SESSION_TTL_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_SESSION_TTL_MS;
  return Math.min(hours, 24 * 365) * 60 * 60 * 1000;
}

export function mintDaemonSession(
  apiToken: string,
  options?: { now?: number; ttlMs?: number },
): { value: string; expiresAt: number } {
  const now = options?.now ?? Date.now();
  const ttlMs = options?.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const expiresAt = now + ttlMs;
  const payload = `${SESSION_VALUE_VERSION}.${expiresAt}`;
  return { value: `${payload}.${sign(apiToken, payload)}`, expiresAt };
}

export function daemonSessionMatches(
  value: unknown,
  apiToken: string,
  now = Date.now(),
): boolean {
  if (typeof value !== 'string' || apiToken.length === 0) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_VALUE_VERSION) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const signature = parts[2];
  if (signature === undefined) return false;
  return secretsMatch(signature, sign(apiToken, `${parts[0]}.${parts[1]}`));
}

/** First value for `name` in a `Cookie:` header, or null. */
export function readCookie(header: unknown, name: string): string | null {
  if (typeof header !== 'string' || !header) return null;
  for (const entry of header.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() !== name) continue;
    const value = entry.slice(separator + 1).trim();
    if (value) return value;
    return null;
  }
  return null;
}

/**
 * `SameSite=None` is only legal on a `Secure` cookie, and a browser refuses a
 * cross-site cookie without it. A split-origin deployment served over plain
 * HTTP therefore cannot hold a session at all — the caller turns this into an
 * explicit error instead of a cookie that is silently dropped.
 */
export function sessionCookieShapeAvailable(crossSite: boolean, secure: boolean): boolean {
  return !crossSite || secure;
}

export interface SessionCookieInit {
  value: string;
  maxAgeSeconds: number;
  secure: boolean;
  crossSite: boolean;
}

export function serializeSessionCookie(init: SessionCookieInit): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${init.value}`,
    `Path=${SESSION_COOKIE_PATH}`,
    'HttpOnly',
    `SameSite=${init.crossSite ? 'None' : 'Lax'}`,
    `Max-Age=${Math.max(0, Math.floor(init.maxAgeSeconds))}`,
  ];
  if (init.secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearSessionCookie(init: { secure: boolean; crossSite: boolean }): string {
  return serializeSessionCookie({ ...init, value: '', maxAgeSeconds: 0 });
}

export function requestIsHttps(forwardedProto: unknown, secure: boolean): boolean {
  const proto = typeof forwardedProto === 'string' ? forwardedProto.split(',')[0]?.trim().toLowerCase() : '';
  return secure || proto === 'https';
}

/**
 * `Sec-Fetch-Site` is the browser's own classification and the only one that
 * distinguishes "another subdomain of the same site" (a `Lax` cookie still
 * travels) from "another registrable domain" (it does not). Absent header —
 * older browsers, non-browser clients — falls back to `Lax`, which is the
 * stricter choice.
 */
export function requestIsCrossSite(secFetchSite: unknown): boolean {
  return typeof secFetchSite === 'string' && secFetchSite.trim().toLowerCase() === 'cross-site';
}
