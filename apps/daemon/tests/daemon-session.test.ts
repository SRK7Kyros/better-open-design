import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { registerDaemonSessionRoutes } from '../src/routes/daemon-session.js';
import {
  clearSessionCookie,
  daemonSessionMatches,
  mintDaemonSession,
  readCookie,
  requestIsCrossSite,
  requestIsHttps,
  SESSION_COOKIE_NAME,
  serializeSessionCookie,
} from '../src/http/session-cookie.js';

const TOKEN = 'a'.repeat(64);

describe('daemon session value', () => {
  it('round-trips and never contains the token itself', () => {
    const { value, expiresAt } = mintDaemonSession(TOKEN, { now: 1_000, ttlMs: 60_000 });
    expect(expiresAt).toBe(61_000);
    expect(daemonSessionMatches(value, TOKEN, 60_000)).toBe(true);
    expect(daemonSessionMatches(value, TOKEN, 61_000)).toBe(false);
    expect(value).not.toContain(TOKEN);
  });

  it('rejects a tampered expiry, a foreign signature and a different token', () => {
    const { value } = mintDaemonSession(TOKEN, { now: 1_000, ttlMs: 60_000 });
    const [version, expiry, signature = ''] = value.split('.');
    expect(daemonSessionMatches(`${version}.${Number(expiry) + 60_000}.${signature}`, TOKEN, 1_000))
      .toBe(false);
    expect(daemonSessionMatches(`${version}.${expiry}.${'b'.repeat(signature.length)}`, TOKEN, 1_000))
      .toBe(false);
    expect(daemonSessionMatches(value, 'c'.repeat(64), 1_000)).toBe(false);
    expect(daemonSessionMatches('v2.9999999999999.abc', TOKEN, 1_000)).toBe(false);
    expect(daemonSessionMatches(undefined, TOKEN, 1_000)).toBe(false);
  });

  it('reads a cookie out of a header and stops at the first value', () => {
    expect(readCookie('a=1; od_session=xyz; b=2', SESSION_COOKIE_NAME)).toBe('xyz');
    expect(readCookie('od_session=', SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie('other=1', SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie(undefined, SESSION_COOKIE_NAME)).toBeNull();
  });

  it('serializes the attributes a browser needs', () => {
    const lax = serializeSessionCookie({
      value: 'v', maxAgeSeconds: 60, secure: true, crossSite: false,
    });
    expect(lax).toContain(`${SESSION_COOKIE_NAME}=v`);
    expect(lax).toContain('HttpOnly');
    expect(lax).toContain('Path=/');
    expect(lax).toContain('SameSite=Lax');
    expect(lax).toContain('Secure');

    const none = serializeSessionCookie({
      value: 'v', maxAgeSeconds: 60, secure: true, crossSite: true,
    });
    expect(none).toContain('SameSite=None');

    expect(clearSessionCookie({ secure: true, crossSite: false })).toContain('Max-Age=0');
  });

  it('classifies transport and site from the headers the proxy sets', () => {
    expect(requestIsHttps('https', false)).toBe(true);
    expect(requestIsHttps('http', true)).toBe(true);
    expect(requestIsHttps(undefined, false)).toBe(false);
    expect(requestIsCrossSite('cross-site')).toBe(true);
    expect(requestIsCrossSite('same-site')).toBe(false);
    expect(requestIsCrossSite(undefined)).toBe(false);
  });
});

async function withRoutes(
  options: { authEnabled: boolean; trustedPeer?: boolean },
  run: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  registerDaemonSessionRoutes(app, {
    apiToken: TOKEN,
    apiTokenAuthEnabled: options.authEnabled,
    isTrustedPeer: () => options.trustedPeer === true,
    hasValidAuthorization: () => false,
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

let lastServer: Server | undefined;
afterEach(async () => {
  if (lastServer) await new Promise<void>((resolve) => lastServer?.close(() => resolve()));
  lastServer = undefined;
});

describe('session routes', () => {
  it('reports an unauthenticated caller when the daemon needs a token', async () => {
    await withRoutes({ authEnabled: true }, async (base) => {
      const res = await fetch(`${base}/api/auth/session`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ required: true, authenticated: false });
    });
  });

  it('reports a trusted peer and a daemon without auth as authenticated', async () => {
    await withRoutes({ authEnabled: true, trustedPeer: true }, async (base) => {
      expect(await (await fetch(`${base}/api/auth/session`)).json())
        .toEqual({ required: true, authenticated: true });
    });
    await withRoutes({ authEnabled: false }, async (base) => {
      expect(await (await fetch(`${base}/api/auth/session`)).json())
        .toEqual({ required: false, authenticated: true });
    });
  });

  it('rejects a wrong token and accepts the right one with an HttpOnly cookie', async () => {
    await withRoutes({ authEnabled: true }, async (base) => {
      const rejected = await fetch(`${base}/api/auth/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'nope' }),
      });
      expect(rejected.status).toBe(401);

      const accepted = await fetch(`${base}/api/auth/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN }),
      });
      expect(accepted.status).toBe(200);
      const cookie = accepted.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Max-Age=');
    });
  });

  it('refuses a cross-site cookie over plain HTTP instead of setting one that is dropped', async () => {
    await withRoutes({ authEnabled: true }, async (base) => {
      const res = await fetch(`${base}/api/auth/session`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site',
        },
        body: JSON.stringify({ token: TOKEN }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('SESSION_COOKIE_UNSUPPORTED');
    });
  });

  it('sets SameSite=None; Secure for a cross-site https deployment', async () => {
    await withRoutes({ authEnabled: true }, async (base) => {
      const res = await fetch(`${base}/api/auth/session`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ token: TOKEN }),
      });
      expect(res.status).toBe(200);
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('SameSite=None');
      expect(cookie).toContain('Secure');
    });
  });

  it('rate-limits repeated unlock attempts', async () => {
    await withRoutes({ authEnabled: true }, async (base) => {
      const attempt = async () =>
        (await fetch(`${base}/api/auth/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: 'nope' }),
        })).status;
      for (let i = 0; i < 10; i += 1) expect(await attempt()).toBe(401);
      expect(await attempt()).toBe(429);
    });
  });

  it('clears the cookie on logout', async () => {
    await withRoutes({ authEnabled: true }, async (base) => {
      const res = await fetch(`${base}/api/auth/session`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
    });
  });
});

// Behind a reverse proxy every browser shares the proxy's socket address, so a
// per-socket bucket made ten typos lock out *everyone* for five minutes — and
// made an unauthenticated login DoS a ten-request exercise.
describe('unlock attempts behind a reverse proxy', () => {
  const badAttempt = async (base: string, forwardedFor?: string): Promise<number> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
    const res = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: 'nope' }),
    });
    return res.status;
  };

  it('buckets a proxied client by its forwarded address, not by the proxy', async () => {
    await withRoutes({ authEnabled: true }, async (base) => {
      for (let i = 0; i < 10; i += 1) {
        expect(await badAttempt(base, '203.0.113.10')).toBe(401);
      }
      expect(await badAttempt(base, '203.0.113.10')).toBe(429);
      // A different browser arriving through the same proxy keeps its own budget.
      expect(await badAttempt(base, '203.0.113.11')).toBe(401);
    });
  });

  it('reads the address the proxy appended, not the one the client claimed', async () => {
    await withRoutes({ authEnabled: true }, async (base) => {
      for (let i = 0; i < 10; i += 1) {
        expect(await badAttempt(base, `198.51.100.${i}, 203.0.113.20`)).toBe(401);
      }
      // Same real client, different claim in front: still the same bucket.
      expect(await badAttempt(base, '192.0.2.99, 203.0.113.20')).toBe(429);
      expect(await badAttempt(base, '203.0.113.21')).toBe(401);
    });
  });

  it('ignores a forwarded header that did not come from a proxy', async () => {
    const app = express();
    app.use(express.json());
    registerDaemonSessionRoutes(app, {
      apiToken: TOKEN,
      apiTokenAuthEnabled: true,
      isTrustedPeer: () => false,
      hasValidAuthorization: () => false,
    });
    const server: Server = createServer(app);
    server.prependListener('connection', (socket) => {
      Object.defineProperty(socket, 'remoteAddress', {
        configurable: true,
        value: '203.0.113.7',
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; i < 10; i += 1) {
        expect(await badAttempt(base, `198.51.100.${i}`)).toBe(401);
      }
      expect(await badAttempt(base, '198.51.100.99')).toBe(429);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
