// `requireLocalDaemonRequest` guards the routes that act on the daemon's own
// machine (library mutations, connector grants, db maintenance, shutdown). They
// used to demand a *loopback Host header*, which is true on the desktop and
// false behind every reverse proxy: nginx forwards `Host: od.example.com`, so
// the whole library answered 403 "request host must be a loopback daemon
// address" on exactly the deployment shape the fork documents as recommended.
//
// The check exists to stop DNS rebinding, not to prove the browser is local: a
// rebound page sends its own hostname, which is not loopback and is not
// allowlisted either. So the rule is "Host/Origin must name this daemon", where
// a declared `OD_ALLOWED_ORIGINS` entry counts as naming it.

import { afterEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';

import { validateLocalDaemonRequest } from '../src/http/local-daemon-request.js';

const PROXY_ORIGIN = 'https://od.example.com';
const PROXY_HOST = 'od.example.com';

function request(
  headers: Record<string, string>,
  remoteAddress = '127.0.0.1',
): Request {
  const lowered = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    socket: { remoteAddress },
    get: (name: string) => lowered.get(name.toLowerCase()),
  } as unknown as Request;
}

afterEach(() => {
  delete process.env.OD_ALLOWED_ORIGINS;
});

describe('validateLocalDaemonRequest on the desktop', () => {
  it('accepts a loopback peer that names the loopback daemon', () => {
    const result = validateLocalDaemonRequest(
      request({ host: '127.0.0.1:7456', origin: 'http://127.0.0.1:7456' }),
    );
    expect(result).toEqual({ ok: true, origin: 'http://127.0.0.1:7456' });
  });

  it('still refuses a browser page from another origin', () => {
    const result = validateLocalDaemonRequest(
      request({ host: '127.0.0.1:7456', origin: 'https://attacker.example' }),
    );
    expect(result).toMatchObject({ ok: false, details: { header: 'origin' } });
  });

  it('still refuses a rebound hostname', () => {
    process.env.OD_ALLOWED_ORIGINS = PROXY_ORIGIN;
    const result = validateLocalDaemonRequest(
      request({ host: 'attacker.example', origin: 'https://attacker.example' }),
    );
    expect(result).toMatchObject({ ok: false, details: { header: 'host' } });
  });

  it('refuses a remote peer that sends no origin', () => {
    process.env.OD_ALLOWED_ORIGINS = PROXY_ORIGIN;
    const result = validateLocalDaemonRequest(
      request({ host: PROXY_HOST }, '203.0.113.7'),
    );
    expect(result).toMatchObject({ ok: false, details: { peer: 'remoteAddress' } });
  });
});

describe('validateLocalDaemonRequest behind a reverse proxy', () => {
  it('accepts the proxied host and origin from the allowlist', () => {
    process.env.OD_ALLOWED_ORIGINS = PROXY_ORIGIN;
    const result = validateLocalDaemonRequest(
      request({ host: PROXY_HOST, origin: PROXY_ORIGIN }),
    );
    expect(result).toEqual({ ok: true, origin: PROXY_ORIGIN });
  });

  it('matches a non-default port in the allowlist', () => {
    process.env.OD_ALLOWED_ORIGINS = 'https://od.example.com:8443';
    const result = validateLocalDaemonRequest(
      request({ host: 'od.example.com:8443', origin: 'https://od.example.com:8443' }),
    );
    expect(result).toEqual({ ok: true, origin: 'https://od.example.com:8443' });
  });

  it('refuses a proxied request whose origin is not allowlisted', () => {
    process.env.OD_ALLOWED_ORIGINS = PROXY_ORIGIN;
    const result = validateLocalDaemonRequest(
      request({ host: PROXY_HOST, origin: 'https://staging.example' }),
    );
    expect(result).toMatchObject({ ok: false, details: { header: 'origin' } });
  });

  it('accepts a browser on another machine that declares its origin', () => {
    process.env.OD_ALLOWED_ORIGINS = PROXY_ORIGIN;
    const result = validateLocalDaemonRequest(
      request({ host: PROXY_HOST, origin: PROXY_ORIGIN }, '203.0.113.7'),
    );
    expect(result).toEqual({ ok: true, origin: PROXY_ORIGIN });
  });

  it('refuses a remote peer with an allowlisted host but no origin', () => {
    process.env.OD_ALLOWED_ORIGINS = PROXY_ORIGIN;
    const result = validateLocalDaemonRequest(
      request({ host: PROXY_HOST }, '203.0.113.7'),
    );
    expect(result.ok).toBe(false);
  });
});
