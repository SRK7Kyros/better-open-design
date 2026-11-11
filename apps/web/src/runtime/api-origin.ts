/**
 * Split-origin support: let the web bundle run on one origin while the daemon
 * lives on another.
 *
 * Upstream ships the client and the daemon from the same Express process, so
 * every call is a relative `/api/…` fetch and no origin ever has to be named.
 * That works for the desktop app and for a reverse-proxied deployment, but it
 * makes the web build unusable when it is served as a plain static site from a
 * separate host (CDN, object storage, another nginx box).
 *
 * The base is resolved once at boot and then applied by a thin interceptor over
 * `fetch` and `EventSource`. Patching the two transports — instead of editing
 * several hundred call sites — keeps this fork rebaseable: upstream can keep
 * writing `fetch('/api/…')` and it resolves to the configured daemon.
 *
 * Unset base (the default, and what every existing deployment has) leaves both
 * transports untouched, so this module is a no-op unless the operator opts in.
 */

export interface OpenDesignRuntimeConfig {
  /** Absolute origin of the daemon, optionally with a path prefix. */
  apiBase?: string;
}

declare global {
  interface Window {
    __OD_CONFIG__?: OpenDesignRuntimeConfig;
  }
}

/**
 * Browser subresource paths the daemon owns. `/api` is the data surface; the
 * rest are documents and assets that artifacts and previews link to relatively
 * and that must therefore be fetched from the daemon, not from the static host.
 */
const DAEMON_PATH_PREFIXES = ['/api/', '/artifacts/', '/frames/', '/plugins/'] as const;

const DAEMON_EXACT_PATHS = new Set(['/api', '/artifacts', '/frames', '/plugins']);

export function normalizeApiBase(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return '';
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

export interface ResolveApiBaseInput {
  runtime?: OpenDesignRuntimeConfig | undefined;
  meta?: string | null;
  env?: string | undefined;
}

/**
 * Resolution order: runtime injection → document meta tag → build-time env.
 * Static deployments can edit one meta line in `index.html` without rebuilding;
 * the meta tag is what a build writes from `NEXT_PUBLIC_OD_API_BASE`.
 */
export function resolveApiBase(input: ResolveApiBaseInput): string {
  return (
    normalizeApiBase(input.runtime?.apiBase)
    || normalizeApiBase(input.meta)
    || normalizeApiBase(input.env)
  );
}

function isDaemonPath(pathname: string): boolean {
  if (DAEMON_EXACT_PATHS.has(pathname)) return true;
  return DAEMON_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Rewrite a same-origin daemon URL onto the configured base. Anything that is
 * already absolute, protocol-relative, or unrelated to the daemon is returned
 * unchanged so blob:, data:, and third-party URLs keep working. Absolute URLs
 * are only touched when they point at the page's own origin (`currentOrigin`),
 * which is what client code that builds `location.origin + '/api/…'` produces.
 */
export function rewriteApiUrl(target: string, apiBase: string, currentOrigin?: string): string {
  if (!apiBase) return target;
  if (target.startsWith(apiBase)) return target;
  if (target.startsWith('//')) return target;
  if (target.startsWith('/')) {
    const queryIndex = target.search(/[?#]/);
    const pathname = queryIndex === -1 ? target : target.slice(0, queryIndex);
    if (!isDaemonPath(pathname)) return target;
    return `${apiBase}${target}`;
  }
  if (!currentOrigin) return target;
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return target;
  }
  if (parsed.origin !== currentOrigin) return target;
  if (!isDaemonPath(parsed.pathname)) return target;
  return `${apiBase}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Resolve a daemon path for the places that need a *string* — a CSS
 * `url()`, a `@font-face` src, anything the attribute rewriter cannot see.
 * Returns the input unchanged when no base is configured.
 */
export function daemonResourceUrl(target: string): string {
  if (typeof window === 'undefined') return target;
  const base = (window as BrowserGlobal & { __odApiOriginInstalled?: string })
    .__odApiOriginInstalled;
  if (!base) return target;
  return rewriteApiUrl(target, base, window.location?.origin);
}

type BrowserGlobal = Window & typeof globalThis;

/**
 * Attributes whose value the browser fetches or navigates to on its own, with
 * no JavaScript in between. `fetch` and `EventSource` are patched separately;
 * this set is what covers `<img src>`, `<video poster>`, `<iframe src>`,
 * `<a href>` downloads and `<script src>`.
 */
const FETCHED_ATTRIBUTES = new Set(['src', 'href', 'poster', 'action', 'data-src']);

const SUBRESOURCE_MARKER = '__odSubresourceRewriterInstalled';

/**
 * Rewrite daemon paths written straight into the DOM.
 *
 * The `fetch`/`EventSource` patches cannot help here: React sets `src="/api/…"`
 * as an attribute and the browser starts the request itself, so in a split-origin
 * deployment every artifact image, poster, download link and preview frame
 * pointed at the *static host* and 404'd. There are 130+ such call sites across
 * the tree, so rewriting them one by one would be both fragile and a permanent
 * rebase conflict; the attribute setter is the single choke point.
 *
 * Only attributes that `rewriteApiUrl` recognises as daemon paths are touched,
 * so third-party URLs, `blob:`, `data:` and anchors that point at the SPA keep
 * their value. The rewrite is idempotent — a value that already starts with the
 * base comes back unchanged — so re-setting an attribute cannot loop.
 */
export function installDaemonSubresourceRewriter(win: BrowserGlobal, apiBase: string): void {
  const attributes = win.Element?.prototype;
  if (!apiBase || typeof attributes?.setAttribute !== 'function') return;
  const marked = attributes as unknown as Record<string, unknown>;
  if (marked[SUBRESOURCE_MARKER]) return;

  const currentOrigin = win.location?.origin;
  const nativeSetAttribute = attributes.setAttribute;

  const rewrite = (name: unknown, value: unknown): unknown => {
    if (typeof name !== 'string' || typeof value !== 'string' || value.length === 0) return value;
    if (!FETCHED_ATTRIBUTES.has(name.toLowerCase())) return value;
    return rewriteApiUrl(value, apiBase, currentOrigin);
  };

  Object.defineProperty(attributes, 'setAttribute', {
    configurable: true,
    writable: true,
    value(this: Element, name: string, value: string) {
      return nativeSetAttribute.call(this, name, rewrite(name, value) as string);
    },
  });
  marked[SUBRESOURCE_MARKER] = true;
}

function readRuntimeBase(win: BrowserGlobal): string {
  const doc = win.document as Document | undefined;
  const meta = doc?.querySelector?.('meta[name="od-api-base"]')?.getAttribute('content') ?? null;
  return resolveApiBase({
    runtime: win.__OD_CONFIG__,
    meta,
    env: process.env.NEXT_PUBLIC_OD_API_BASE,
  });
}

/**
 * Install the interceptor. Idempotent: a second call returns the base that is
 * already in effect, which keeps React strict-mode double-invocation and
 * client-side remounts from stacking wrappers.
 */
export function installApiOriginRewriter(win?: BrowserGlobal): string {
  const target = win ?? (typeof window === 'undefined' ? null : window);
  if (target == null) return '';
  const marked = target as BrowserGlobal & { __odApiOriginInstalled?: string };
  if (marked.__odApiOriginInstalled != null) return marked.__odApiOriginInstalled;

  const apiBase = readRuntimeBase(target);
  marked.__odApiOriginInstalled = apiBase;
  if (!apiBase) return '';

  installDaemonSubresourceRewriter(target, apiBase);

  const currentOrigin = target.location?.origin;
  const nativeFetch = target.fetch.bind(target);

  const targetsDaemon = (original: string, rewritten: string): boolean =>
    rewritten !== original || original.startsWith(apiBase);

  const withCredentials = (init: RequestInit | undefined): RequestInit =>
    init?.credentials ? init : { ...init, credentials: 'include' };

  const copyRequest = (request: Request, url: string): Request => {
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers: request.headers,
      credentials: 'include',
      mode: request.mode,
      cache: request.cache,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      integrity: request.integrity,
      keepalive: request.keepalive,
      signal: request.signal,
    };
    if (request.body != null) {
      init.body = request.body;
      init.duplex = 'half';
    }
    return new target.Request(url, init);
  };

  target.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') {
      const url = rewriteApiUrl(input, apiBase, currentOrigin);
      return nativeFetch(url, targetsDaemon(input, url) ? withCredentials(init) : init);
    }
    if (input instanceof URL) {
      const url = rewriteApiUrl(input.href, apiBase, currentOrigin);
      return nativeFetch(url, targetsDaemon(input.href, url) ? withCredentials(init) : init);
    }
    if (target.Request && input instanceof target.Request) {
      const rewritten = rewriteApiUrl(input.url, apiBase, currentOrigin);
      if (targetsDaemon(input.url, rewritten)) {
        return nativeFetch(copyRequest(input, rewritten), init);
      }
    }
    return nativeFetch(input as RequestInfo, init);
  }) as typeof target.fetch;

  // `window.open('/api/…')` is the third URL-taking transport: it opens the tab
  // itself, so the browser — not our code — resolves the relative path.
  if (typeof target.open === 'function') {
    const nativeOpen = target.open.bind(target);
    target.open = ((url?: string | URL, ...rest: unknown[]) => {
      const rawUrl = typeof url === 'string' ? url : url?.href;
      const rewritten = rawUrl ? rewriteApiUrl(rawUrl, apiBase, currentOrigin) : rawUrl;
      return nativeOpen(rewritten as string | URL | undefined, ...(rest as []));
    }) as typeof target.open;
  }

  const NativeEventSource = target.EventSource;
  if (typeof NativeEventSource === 'function') {
    const RewritingEventSource = function (
      this: EventSource,
      url: string | URL,
      config?: EventSourceInit,
    ) {
      const rawUrl = typeof url === 'string' ? url : url.href;
      const rewritten = rewriteApiUrl(rawUrl, apiBase, currentOrigin);
      const credentials = targetsDaemon(rawUrl, rewritten)
        ? { withCredentials: true, ...(config ?? {}) }
        : config;
      return new NativeEventSource(rewritten, credentials);
    } as unknown as typeof EventSource;
    RewritingEventSource.prototype = NativeEventSource.prototype;
    Object.assign(RewritingEventSource, {
      CONNECTING: NativeEventSource.CONNECTING,
      OPEN: NativeEventSource.OPEN,
      CLOSED: NativeEventSource.CLOSED,
    });
    target.EventSource = RewritingEventSource;
  }

  return apiBase;
}
