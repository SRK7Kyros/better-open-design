# Serving the OpenDesign web build from its own origin (better-open-design)

Upstream ships one process that serves both the API and the Next.js export, so
"the web app" and "the backend" are the same origin by construction. This fork
keeps that shape working and adds the two deployment shapes below.

Pick the one that matches how much of the daemon surface you need.

| Shape | Web build served by | API reached via | Subresources (`/artifacts`, `/frames`, `/plugins`, raw files) | When |
|---|---|---|---|---|
| **A. Single process** (upstream) | the daemon | same origin | same origin | laptop, desktop shell, `od` CLI |
| **B. Reverse proxy** (recommended self-host) | nginx / Caddy / Traefik | proxied prefixes | proxied prefixes | a URL for the web UI and the daemon on a private port |
| **C. Split origin** | any static host (CDN, S3, another box) | `NEXT_PUBLIC_OD_API_BASE` / `<meta name="od-api-base">` | proxied by the static host, or same origin when C is only used for API-heavy embeds | embedding the UI inside another product |

Shape B is the one to use when in doubt: the browser sees one origin, which is
what artifacts (iframes, `<img>`, `<script src>`) assume, and no CORS is
involved.

---

## Shape B — nginx in front of the daemon

Build and publish the static export:

```bash
pnpm install --frozen-lockfile
pnpm --filter @open-design/web build          # writes apps/web/out
```

Copy `apps/web/out/` to the web root in `nginx-od-web.conf`, start the daemon on
loopback with the public origin allow-listed:

```bash
OD_BIND_HOST=127.0.0.1 \
OD_PORT=7456 \
OD_ALLOWED_ORIGINS=https://od.example.com \
OD_API_TOKEN=$(openssl rand -hex 32) \
od --no-open
```

`OD_ALLOWED_ORIGINS` matters even though the browser sees one origin: the daemon
sees the proxy's upstream `Host`, not `od.example.com`, so the browser-visible
origin has to be declared explicitly (see `apps/daemon/src/origin-validation.ts`).

Why each proxied prefix is needed:

| Prefix | Producer | Consumed by |
|---|---|---|
| `/api/` | daemon REST + SSE | the SPA (runs, chat, library, settings) |
| `/artifacts/` | daemon media outputs | `<img>`/`<video>` inside artifact previews |
| `/frames/` | daemon export frames | deck thumbnails, PDF export |
| `/plugins/` | baked plugin preview clips | the plugin gallery |

Trailing-slash SPA fallback (`try_files … /index.html`) is required: the product
routes everything through one catch-all (`apps/web/app/[[...slug]]/page.tsx`), so
a deep link must return the shell, not a 404.

SSE note: `proxy_buffering off` and a long `proxy_read_timeout` are not optional
— runs and chat stream over `/api/runs` and stall silently when nginx buffers.

---

## Shape C — web bundle on another origin than the daemon

Build with the daemon origin baked in, or edit one line of the built
`index.html` afterwards (no rebuild) — the runtime reads both:

```bash
NEXT_PUBLIC_OD_API_BASE=https://od-api.example.com pnpm --filter @open-design/web build
```

```html
<!-- apps/web/out/index.html, after `next build` -->
<meta name="od-api-base" content="https://od-api.example.com" />
```

The client resolves the base in this order (`apps/web/src/runtime/api-origin.ts`):

1. `window.__OD_CONFIG__.apiBase` — injected by an embedding host before the app boots;
2. `<meta name="od-api-base">` — the line above;
3. `NEXT_PUBLIC_OD_API_BASE` — build-time default;
4. unset → same-origin, i.e. exactly upstream's behaviour.

With a base set, `fetch` and `EventSource` calls that target `/api/…`,
`/artifacts/…`, `/frames/…` or `/plugins/…` are rewritten onto that origin. The
daemon must allow the web origin:

```bash
OD_ALLOWED_ORIGINS=https://od.example.com https://staging.od.example.com
```

which both permits the request (`origin-validation.ts`) and emits the CORS
response headers plus the preflight answer (`apps/daemon/src/http/cors-allowlist.ts`).
Credentials are allowed for exactly those origins, never `*`.

Shape C is not finished yet: the rewriter covers `fetch` and `EventSource`, not
browser-native subresource loads, and the client has no way to present
`OD_API_TOKEN`. Both are tracked — with the fix and its evidence — in
[`HOSTED-GAPS.md`](./HOSTED-GAPS.md). Until gaps 1, 2 and 4 there are closed,
use shape B for anything where the preview panel or chat streaming matters.

`OD_ALLOWED_ORIGINS` has to be set here even when the framing page and the
daemon are the same origin: it is the source of the `frame-ancestors` policy on
preview documents (`apps/daemon/src/http/frame-ancestors.ts`), so without it a
split-origin preview renders as an empty canvas.

---

## Environment reference

| Variable | Side | Meaning |
|---|---|---|
| `OD_DAEMON_ORIGIN` | web (dev + proxy rewrites) | daemon origin `next dev` proxies to; default `http://127.0.0.1:$OD_PORT` |
| `NEXT_PUBLIC_OD_API_BASE` | web build | absolute daemon base baked into the bundle |
| `OD_ALLOWED_ORIGINS` | daemon | comma-separated browser origins allowed to call `/api`, to receive CORS headers, and to frame preview documents (`frame-ancestors`) |
| `OD_BIND_HOST` | daemon | interface to bind; keep `127.0.0.1` behind a proxy |
| `OD_WEB_PORT` | daemon | extra port treated as same-origin (proxy-fronted single-process setups) |
