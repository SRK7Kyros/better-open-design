import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeDaemonSession, unlockDaemon } from '../../src/runtime/daemon-session';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

describe('probeDaemonSession', () => {
  it('reports the daemon answer with credentials attached', async () => {
    const calls = stubFetch(async () => Response.json({ required: true, authenticated: false }));
    expect(await probeDaemonSession()).toEqual({ required: true, authenticated: false });
    expect(calls[0]?.url).toBe('/api/auth/session');
    expect(calls[0]?.init?.credentials).toBe('include');
  });

  it('treats an unreachable daemon as "no answer" instead of blocking boot', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await probeDaemonSession()).toBeNull();
  });

  it('treats a non-2xx answer as "no answer"', async () => {
    stubFetch(async () => new Response('nope', { status: 500 }));
    expect(await probeDaemonSession()).toBeNull();
  });
});

describe('unlockDaemon', () => {
  it('posts the token once and reports success', async () => {
    const calls = stubFetch(async () => Response.json({ ok: true }));
    expect(await unlockDaemon('tok')).toEqual({ ok: true });
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ token: 'tok' }));
  });

  it('surfaces the daemon message on rejection', async () => {
    stubFetch(async () => Response.json(
      { error: { code: 'API_TOKEN_INVALID', message: 'That token was rejected.' } },
      { status: 401 },
    ));
    expect(await unlockDaemon('bad')).toEqual({ ok: false, message: 'That token was rejected.' });
  });

  it('falls back to the status when the body is not the expected shape', async () => {
    stubFetch(async () => new Response('<html>', { status: 502 }));
    expect(await unlockDaemon('tok')).toEqual({ ok: false, message: 'Unlock failed (502).' });
  });

  it('reports a network failure without throwing', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await unlockDaemon('tok')).toEqual({ ok: false, message: 'Could not reach the daemon.' });
  });
});
