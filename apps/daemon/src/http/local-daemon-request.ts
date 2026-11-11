import net from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { configuredAllowedHosts, configuredAllowedOrigins } from '../origin-validation.js';
import { sendApiError } from './api-errors.js';

interface LocalAuthority {
  hostname: string;
  port: string;
}

interface LocalDaemonValidation {
  ok: true;
  origin: string | null;
}

interface LocalDaemonValidationError {
  ok: false;
  message: string;
  details: Record<string, string>;
}

export function normalizeLocalAuthority(value: unknown): LocalAuthority | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /[\s/@]/.test(trimmed) || trimmed.includes(',')) return null;

  try {
    const parsed = new URL(`http://${trimmed}`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname || parsed.username || parsed.password || parsed.pathname !== '/') return null;
    return { hostname, port: parsed.port };
  } catch {
    return null;
  }
}

export function isLoopbackHostname(hostname: unknown): boolean {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (net.isIP(normalized) === 4) return normalized === '127.0.0.1' || normalized.startsWith('127.');
  return false;
}

export function isLoopbackPeerAddress(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) return false;
  if (normalized.startsWith('::ffff:')) return isLoopbackPeerAddress(normalized.slice('::ffff:'.length));
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (net.isIP(normalized) === 4) return normalized === '127.0.0.1' || normalized.startsWith('127.');
  return false;
}

export function localOriginFromHeader(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed.includes(',')) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
    if (!isLoopbackHostname(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * The origins this deployment declares as "a browser allowed to drive the
 * daemon" (`OD_ALLOWED_ORIGINS`). A malformed value must never widen this
 * guard, so parsing failures collapse to an empty list — the caller then sees
 * exactly the desktop-only behaviour.
 */
function declaredOrigins(env: NodeJS.ProcessEnv): { origins: string[]; hosts: string[] } {
  try {
    const origins = configuredAllowedOrigins(env);
    return { origins, hosts: configuredAllowedHosts(origins) };
  } catch {
    return { origins: [], hosts: [] };
  }
}

function declaredOrigin(value: unknown, origins: readonly string[]): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    if (parsed.username || parsed.password) return null;
    return origins.includes(parsed.origin) ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a request may act on the daemon's own machine.
 *
 * This guard covers the routes that mutate daemon-local state (library,
 * connectors, db maintenance, shutdown). The desktop answer — "loopback peer
 * naming the loopback daemon" — is false behind every reverse proxy, which
 * forwards `Host: od.example.com`; requiring loopback there 403'd the whole
 * library on the shape shape B documents as recommended.
 *
 * The check defends DNS rebinding, and a rebound page sends its *own* hostname
 * and origin, neither of which an operator allowlisted: so a declared
 * `OD_ALLOWED_ORIGINS` entry counts as naming this daemon in both places. A
 * remote peer must additionally present a declared origin, so a forged
 * loopback `Origin` from elsewhere buys nothing, and neither does an
 * unauthenticated remote caller.
 */
export function validateLocalDaemonRequest(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
): LocalDaemonValidation | LocalDaemonValidationError {
  const { origins, hosts } = declaredOrigins(env);

  const host = normalizeLocalAuthority(req.get('host'));
  const hostAuthority = host && (host.port ? `${host.hostname}:${host.port}` : host.hostname);
  const hostNamesDaemon = Boolean(
    host
    && (isLoopbackHostname(host.hostname)
      || hosts.includes(hostAuthority as string)
      || hosts.includes(host.hostname)),
  );
  if (!hostNamesDaemon) {
    return {
      ok: false,
      message: 'request host must be a loopback daemon address or an origin declared in OD_ALLOWED_ORIGINS',
      details: { header: 'host' },
    };
  }

  const originHeader = req.get('origin');
  const declared = declaredOrigin(originHeader, origins);
  const origin = declared ?? localOriginFromHeader(originHeader);
  if (originHeader !== undefined && !origin) {
    return {
      ok: false,
      message: 'request origin must be a loopback daemon origin or an origin declared in OD_ALLOWED_ORIGINS',
      details: { header: 'origin' },
    };
  }

  if (!isLoopbackPeerAddress(req.socket?.remoteAddress) && !declared) {
    return {
      ok: false,
      message: 'request peer must be a loopback address unless the request declares an allowlisted origin',
      details: { peer: 'remoteAddress' },
    };
  }

  return { ok: true, origin };
}

export function requireLocalDaemonRequest(req: Request, res: Response, next: NextFunction): void | Response {
  const validation = validateLocalDaemonRequest(req);
  if (!validation.ok) {
    return sendApiError(res, 403, 'FORBIDDEN', validation.message, { details: validation.details });
  }

  res.setHeader('Vary', 'Origin');
  if (validation.origin) {
    res.setHeader('Access-Control-Allow-Origin', validation.origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  next();
}
