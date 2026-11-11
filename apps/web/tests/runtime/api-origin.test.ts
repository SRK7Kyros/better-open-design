// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DAEMON_UNAUTHORIZED_EVENT } from '../../src/runtime/daemon-session';
import {
  installApiOriginRewriter,
  normalizeApiBase,
  resolveApiBase,
  rewriteApiUrl,
} from '../../src/runtime/api-origin';

describe('normalizeApiBase', () => {
  it('keeps an origin and strips a trailing slash', () => {
    expect(normalizeApiBase('https://od.example.com')).toBe('https://od.example.com');
    expect(normalizeApiBase('https://od.example.com/')).toBe('https://od.example.com');
    expect(normalizeApiBase('  https://od.example.com/od/  ')).toBe('https://od.example.com/od');
  });

  it('rejects values that are not a bare http(s) base', () => {
    expect(normalizeApiBase('')).toBe('');
    expect(normalizeApiBase(undefined)).toBe('');
    expect(normalizeApiBase('od.example.com')).toBe('');
    expect(normalizeApiBase('file:///tmp/daemon')).toBe('');
    expect(normalizeApiBase('https://user:pw@od.example.com')).toBe('');
    expect(normalizeApiBase('https://od.example.com/?x=1')).toBe('');
  });
});

describe('resolveApiBase', () => {
  it('prefers runtime injection over meta and env', () => {
    expect(
      resolveApiBase({
        runtime: { apiBase: 'https://runtime.example' },
        meta: 'https://meta.example',
        env: 'https://env.example',
      }),
    ).toBe('https://runtime.example');
  });

  it('falls back through meta and env, and finally to same-origin', () => {
    expect(resolveApiBase({ meta: 'https://meta.example', env: 'https://env.example' }))
      .toBe('https://meta.example');
    expect(resolveApiBase({ env: 'https://env.example' })).toBe('https://env.example');
    expect(resolveApiBase({})).toBe('');
  });
});

describe('rewriteApiUrl', () => {
  const base = 'https://od.example.com';

  it('moves daemon paths onto the configured base', () => {
    expect(rewriteApiUrl('/api/projects?limit=1', base)).toBe('https://od.example.com/api/projects?limit=1');
    expect(rewriteApiUrl('/artifacts/a.png', base)).toBe('https://od.example.com/artifacts/a.png');
    expect(rewriteApiUrl('/frames/f', base)).toBe('https://od.example.com/frames/f');
    expect(rewriteApiUrl('/plugins', base)).toBe('https://od.example.com/plugins');
  });

  it('leaves unrelated and already-absolute URLs alone', () => {
    expect(rewriteApiUrl('/_next/static/chunk.js', base)).toBe('/_next/static/chunk.js');
    expect(rewriteApiUrl('/app-icon.png', base)).toBe('/app-icon.png');
    expect(rewriteApiUrl('https://cdn.example/x', base)).toBe('https://cdn.example/x');
    expect(rewriteApiUrl('//cdn.example/api/x', base)).toBe('//cdn.example/api/x');
    expect(rewriteApiUrl('blob:https://x/y', base)).toBe('blob:https://x/y');
  });

  it('is a no-op when no base is configured', () => {
    expect(rewriteApiUrl('/api/projects', '')).toBe('/api/projects');
  });
});

describe('installApiOriginRewriter', () => {
  function fakeWindow(overrides: Record<string, unknown> = {}) {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    const win = {
      location: { origin: 'https://web.example.com' },
      document: { querySelector: () => null },
      fetch: fetchMock,
      EventSource: class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 2;
        constructor(
          public url: string,
          public config?: { withCredentials?: boolean },
        ) {}
      },
      ...overrides,
    } as unknown as Window & typeof globalThis;
    return { win, fetchMock };
  }

  it('rewrites nothing when no base is set', async () => {
    const { win, fetchMock } = fakeWindow();
    expect(installApiOriginRewriter(win)).toBe('');
    // A same-origin deployment still installs the 401 report (see the
    // 'same-origin deployment' block), but no URL may be touched.
    await win.fetch('/api/info');
    expect(fetchMock).toHaveBeenCalledWith('/api/info', undefined);
    await win.fetch('/assets/logo.svg');
    expect(fetchMock).toHaveBeenCalledWith('/assets/logo.svg', undefined);
  });

  it('rewrites daemon fetches and event streams from the meta tag', async () => {
    const { win, fetchMock } = fakeWindow({
      document: {
        querySelector: (selector: string) =>
          selector === 'meta[name="od-api-base"]' ? { getAttribute: () => 'https://od.example.com' } : null,
      },
    });

    expect(installApiOriginRewriter(win)).toBe('https://od.example.com');

    await win.fetch('/api/info');
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://od.example.com/api/info',
      { credentials: 'include' },
    );

    await win.fetch('/_next/static/chunk.js');
    expect(fetchMock).toHaveBeenLastCalledWith('/_next/static/chunk.js', undefined);

    const stream = new win.EventSource('/api/events');
    expect(stream.url).toBe('https://od.example.com/api/events');
    expect((stream as unknown as { config?: unknown }).config)
      .toEqual({ withCredentials: true });
  });

  it('wraps a Request object instead of dropping its init', async () => {
    const { win, fetchMock } = fakeWindow({
      Request,
      __OD_CONFIG__: { apiBase: 'https://od.example.com' },
    });
    installApiOriginRewriter(win);

    const request = new Request('https://web.example.com/api/runs', { method: 'POST' });
    await win.fetch(request);

    const [rewritten] = fetchMock.mock.calls.at(-1) as unknown as [Request];
    expect(rewritten).toBeInstanceOf(Request);
    expect(rewritten.url).toBe('https://od.example.com/api/runs');
    expect(rewritten.method).toBe('POST');
    expect(rewritten.credentials).toBe('include');
  });

  it('leaves a third-party request without cookies', async () => {
    const { win, fetchMock } = fakeWindow({
      __OD_CONFIG__: { apiBase: 'https://od.example.com' },
    });
    installApiOriginRewriter(win);
    await win.fetch('https://api.stripe.com/v1/charges');
    expect(fetchMock).toHaveBeenLastCalledWith('https://api.stripe.com/v1/charges', undefined);
  });

  it('keeps an explicit credentials mode the caller chose', async () => {
    const { win, fetchMock } = fakeWindow({
      __OD_CONFIG__: { apiBase: 'https://od.example.com' },
    });
    installApiOriginRewriter(win);
    await win.fetch('/api/info', { credentials: 'omit' });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://od.example.com/api/info',
      { credentials: 'omit' },
    );
  });

  it('rewrites window.open so an opened tab lands on the daemon', () => {
    const open = vi.fn(() => null);
    const { win } = fakeWindow({
      open,
      __OD_CONFIG__: { apiBase: 'https://od.example.com' },
    });
    installApiOriginRewriter(win);

    win.open('/api/library/assets/a1/raw', '_blank', 'noopener');
    expect(open).toHaveBeenLastCalledWith(
      'https://od.example.com/api/library/assets/a1/raw',
      '_blank',
      'noopener',
    );

    win.open('https://example.com/docs');
    expect(open).toHaveBeenLastCalledWith('https://example.com/docs');
  });

  it('is idempotent across remounts', () => {
    const { win } = fakeWindow({ __OD_CONFIG__: { apiBase: 'https://od.example.com' } });
    installApiOriginRewriter(win);
    const patched = win.fetch;
    expect(installApiOriginRewriter(win)).toBe('https://od.example.com');
    expect(win.fetch).toBe(patched);
  });
});

describe('daemon session expiry', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__odApiOriginInstalled;
    delete (window as unknown as Record<string, unknown>).__OD_CONFIG__;
  });

  // The wrapper captures `window.fetch` at install time, so the stub has to be
  // in place first.
  function installWithBase(status: number): ReturnType<typeof vi.fn> {
    (window as unknown as Window & { __OD_CONFIG__?: { apiBase: string } }).__OD_CONFIG__ = {
      apiBase: 'https://od.example.com',
    };
    const stub = vi.fn(async () => new Response('{}', { status }));
    (window as unknown as { fetch: unknown }).fetch = stub;
    installApiOriginRewriter(window as unknown as Window & typeof globalThis);
    return stub;
  }

  it('announces a 401 from a daemon request so the shell can ask for the token again', async () => {
    installWithBase(401);
    const seen = vi.fn();
    window.addEventListener(DAEMON_UNAUTHORIZED_EVENT, seen);

    await window.fetch('/api/projects');

    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(DAEMON_UNAUTHORIZED_EVENT, seen);
  });

  it('stays quiet for a 200', async () => {
    installWithBase(200);
    const seen = vi.fn();
    window.addEventListener(DAEMON_UNAUTHORIZED_EVENT, seen);

    await window.fetch('/api/projects');

    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener(DAEMON_UNAUTHORIZED_EVENT, seen);
  });

  it('stays quiet for the session exchange itself', async () => {
    installWithBase(401);
    const seen = vi.fn();
    window.addEventListener(DAEMON_UNAUTHORIZED_EVENT, seen);

    await window.fetch('/api/auth/session', { method: 'POST' });

    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener(DAEMON_UNAUTHORIZED_EVENT, seen);
  });
});

describe('same-origin deployment', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__odApiOriginInstalled;
    delete (window as unknown as Record<string, unknown>).__OD_CONFIG__;
  });

  function installSameOrigin(status: number): ReturnType<typeof vi.fn> {
    // No `__OD_CONFIG__.apiBase`, no meta tag: the default upstream shape.
    const stub = vi.fn(async () => new Response('{}', { status }));
    (window as unknown as { fetch: unknown }).fetch = stub;
    installApiOriginRewriter(window as unknown as Window & typeof globalThis);
    return stub;
  }

  it('still reports a 401 so an expired session can be reopened', async () => {
    // Nothing is rewritten here, but the cookie expires just the same; without
    // the report the shell would keep a workspace whose every panel is dead.
    installSameOrigin(401);
    const seen = vi.fn();
    window.addEventListener(DAEMON_UNAUTHORIZED_EVENT, seen);

    await window.fetch('/api/projects');

    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(DAEMON_UNAUTHORIZED_EVENT, seen);
  });

  it('ignores a 401 from a path the daemon does not own', async () => {
    installSameOrigin(401);
    const seen = vi.fn();
    window.addEventListener(DAEMON_UNAUTHORIZED_EVENT, seen);

    await window.fetch('/favicon.ico');

    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener(DAEMON_UNAUTHORIZED_EVENT, seen);
  });
});
