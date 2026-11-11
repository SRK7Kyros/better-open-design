# Hosted-deployment gap register (better-open-design)

Upstream is one process: Express serves `/api`, `/artifacts`, `/frames`,
`/plugins` **and** the Next.js export. That shapes the client in ways that only
show up once the two are separated, because almost every assumption the web
bundle makes about "the backend" is really an assumption about *sharing an
origin with it*.

This file is the honest inventory of what still breaks when the web build runs
with `apiBase` pointed at a daemon on another origin (shape C in the README),
plus the items that break when it runs behind a reverse proxy (shape B) but the
operator sets `OD_API_TOKEN` instead of terminating auth at the proxy.

Severity is about *the product*, not tidiness: **P0** means a core surface
(preview, chat streaming, opening a project) cannot work; **P1** means it works
only with an operator workaround; **P2** is a sharp edge.

| # | Gap | Severity | Affected shape |
|---|---|---|---|
| 1 | The web bundle has no way to send `OD_API_TOKEN` | ~~P0~~ **fixed** | B (token, no proxy auth), C |
| 2 | `EventSource` cannot carry an `Authorization` header | ~~P0~~ **fixed** | C |
| 3 | Preview documents forbid being framed cross-origin | ~~P0~~ **fixed** | C |
| 4 | Browser-native subresource loads bypass the URL rewriter | ~~P1~~ **fixed** | C |
| 5 | `/api/dialog/open-folder` is loopback/same-origin only | ~~P1~~ **fixed** | B, C |
| 6 | Local-filesystem endpoints assume browser and daemon share a machine | ~~P1~~ **fixed** | B, C |
| 7 | No `basePath` support for serving the build under a sub-path | ~~P2~~ **fixed** | B, C |
| 8 | The editor hand-off surface advertises editors that spawn on the server | ~~P1~~ **fixed** | B, C |
| 9 | `requireLocalDaemonRequest` rejects every proxy-shaped `Host` | ~~P0~~ **fixed** | B, C |
| 10 | Unlock attempts are bucketed per proxy socket, not per browser | ~~P1~~ **fixed** | B, C |
| 11 | The unlock rate-limit table is never swept — unbounded growth | ~~P2~~ **fixed** | B, C |

## 1. The web bundle had no way to send `OD_API_TOKEN` — fixed

The daemon's guard authenticated exactly two credentials: a Bearer token, or
HTTP Basic with username `open-design` and the token as the password. The web
build could produce neither — nothing in `apps/web/src` builds a daemon
credential, and the Basic challenge is not a rescue: browsers present it for
navigations and subresources, and hand a cross-origin `fetch` its 401 instead.

A browser can carry exactly one credential without help: a cookie. So the
daemon now exchanges the token for one:

| Route | Purpose |
|---|---|
| `GET /api/auth/session` | `{ required, authenticated }` — the probe the shell runs before its first paint |
| `POST /api/auth/session` | exchange `{ token }` for an HttpOnly `od_session` cookie (10 attempts / 5 min per peer) |
| `DELETE /api/auth/session` | drop the cookie |

`apps/daemon/src/http/session-cookie.ts` signs the expiry with the API token
(HMAC), so nothing is stored server-side, a restart does not log browsers out,
and rotating `OD_API_TOKEN` invalidates every session at once. The cookie never
contains the token itself. `SameSite=Lax` when the deferred page is same-site
with the daemon (including sibling subdomains), `SameSite=None; Secure` for a
true cross-site deployment over TLS, and an explicit
`400 SESSION_COOKIE_UNSUPPORTED` over plain HTTP — a `None` cookie without
`Secure` is dropped by the browser, so pretending to set it would be worse than
refusing.

On the client, `apps/web/src/runtime/daemon-session.ts` owns the exchange and
`components/DaemonAuthGate.tsx` renders the unlock form when the probe says the
daemon requires a token. A failed probe never blocks the app.

Two things this fixed that were invisible before:

- **Preflight was being 401'd.** The token guard was mounted *before* the CORS
  responder, and a browser preflight never carries credentials — so every
  non-simple request from an allow-listed origin failed before CORS could
  answer it. `OPTIONS` now passes through the guard (it cannot mutate state).
- **The SPA document challenge ignored the session cookie.** The guard that
  challenges static shell navigations accepted only Basic; a cookie-authenticated
  browser would have been challenged on every reload.

## 2. `EventSource` cannot carry an `Authorization` header — fixed

Four live surfaces stream over SSE and all of them construct `EventSource`
directly: `components/LibrarySection.tsx`, `components/MemorySection.tsx`,
`components/MemoryToast.tsx`, `components/workspace/TerminalViewer.tsx` (plus
the chat/run streams inside `providers/registry.ts`). The `EventSource` spec has
no per-request headers; `withCredentials` only adds cookies.

The rewriter now passes `withCredentials: true` for daemon URLs, and the fetch
wrapper adds `credentials: 'include'` to daemon requests — but only to those: a
third-party URL keeps the caller's mode (or the `same-origin` default), so
unrelated origins never start receiving cookies on a deployment that opted into
a daemon base.

## 3. Preview documents forbid being framed cross-origin — fixed

`setLiveArtifactPreviewHeaders` (`apps/daemon/src/live-artifacts/http-helpers.ts`)
and the two CSP strings in `apps/daemon/src/routes/plugins/assets.ts` pinned
`frame-ancestors 'self'`. A page on `https://od.example.com` framing a preview
served by `https://od-api.example.com` is refused by the browser, which is the
"empty preview canvas" symptom on a split-origin install.

Both now emit `frame-ancestors 'self' <OD_ALLOWED_ORIGINS…>` via
`apps/daemon/src/http/frame-ancestors.ts`. `'self'` is always kept; a malformed
entry falls back to `'self'` rather than widening the policy.

Note the remaining, *intentional* restriction on the same document:
`script-src 'none'` and `sandbox allow-same-origin` mean the `rendered` variant
never runs artifact JavaScript. That is the design of the rendered transport —
interactive previews go through `/api/projects/:id/files/:name/preview`.

## 4. Browser-native subresource loads bypass the URL rewriter — fixed

`rewriteApiUrl` only sees `fetch`, `Request` and `EventSource`. Anything the
markup loads directly — `<img src="/artifacts/…">`, `<video poster>`,
`<link rel="stylesheet" href="/api/…">`, an `<iframe>` whose `src` came from a
string the app did not build through `fetch` — resolves against the *web*
origin and 404s there.

Measured: 25 places in `apps/web/src` return a template literal starting with
`/api/` (asset and thumbnail builders), and `workspaceResourceUrl` has 29 call
sites that deliberately stay relative.

Both routes were on the table; the smaller diff won. There is no
`MutationObserver` and no per-call-site helper — `installDaemonSubresourceRewriter`
wraps `Element.prototype.setAttribute` and rewrites `src`, `href`, `poster`,
`action` and `data-src` through the same `rewriteApiUrl` the transports use.
React sets those attributes with `setAttribute`, so the rewrite happens *before*
the browser starts the request, which a `MutationObserver` cannot promise.

It is installed by `installApiOriginRewriter` and is a no-op when no
`apiBase` resolves, so every same-origin deployment is untouched. The rewrite is
idempotent (a value that already starts with the base is returned unchanged),
which is what keeps a re-set attribute from looping, and values the rewriter does
not recognise — third-party URLs, `blob:`, `data:`, SPA routes like
`/projects/x` — keep their value because only the four daemon prefixes match.
Covered by `apps/web/tests/runtime/api-origin-subresources.test.ts`.

## 5. `/api/dialog/open-folder` is loopback/same-origin only — fixed

`apps/daemon/src/routes/media.ts` guards the picker with
`isLocalSameOrigin(req, getResolvedPort())` and otherwise answers
`403 cross-origin request rejected`. The web calls it unconditionally
(`state/projects.ts` `pickLocalFolderPath`, also `state/project-locations.ts`
and `providers/registry.ts`), so in a hosted deployment the "Choose folder"
action always fails — with a message that reads like a bug rather than a
deployment property.

It also cannot be made to work as-is: the dialog would appear on the *daemon's*
desktop, and the path it returns is meaningful only to the daemon.

The daemon now answers `501 FOLDER_PICKER_UNAVAILABLE` with an explanation
instead of `403 cross-origin request rejected`, and `GET /api/host-capabilities`
lets the client know before the click: `{ sameMachine, folderPicker,
localFolders, systemTerminal }`. `apps/web/src/runtime/host-capabilities.ts`
probes it once per page load; `openFolderDialog` and `pickLocalFolderPath` stop
before issuing a request that cannot succeed and raise the same explanation.

Still open: no component offers a text field for the server-side path yet. The
import routes already accept a path string, so the picker is only sugar — the
follow-up is to render that field when `folderPicker` is false rather than
letting the action end at a message.

## 6. Local-filesystem endpoints assumed one machine — fixed

The UI offered operations whose subject lives on the daemon's disk. Two were
real, two were listed here by mistake, and the honest answer differs per row:

| Endpoint | What it actually does | Hosted answer |
|---|---|---|
| `POST /api/dir-exists` | stats a path the user typed, to flag a linked working directory that was deleted | correct as-is: the path *is* on the daemon, and the check reports on the daemon |
| `POST /api/design-systems/import/local` | reads a project folder from the daemon's disk | **label it**: the field now says the path is read on the daemon's machine |
| `POST /api/plugins/upload-folder` | uploads the picked folder's **file contents** as multipart | already works hosted — nothing to fix (it was wrongly listed here) |
| `POST /api/agents/:agentId/oauth-launch` | spawns a system terminal on the daemon host | no UI calls it any more; `onLaunchTerminalAuth` / `onLaunchAntigravityOauth` are dead props, not a hosted gap |
| `GET /api/projects/:id/files` | serves the project tree from the daemon's disk | already correct: the daemon is the one reading it |

What changed:

- `DesignSystemsSection` probes `/api/host-capabilities` and, when
  `folderPicker` is false, prints `settings.designSystemsLocalServerHint` under
  the local-import field ("the path is read on the daemon's machine") in all 19
  locales.
- `WorkingDirPicker` no longer offers **Choose folder** when the daemon cannot
  open a dialog on this desktop — `openFolderDialog` already returned `null`
  there, so the row was a click that did nothing. It shows
  `homeWorkingDir.serverOnly` instead, and still lists recent (server) folders
  and clears the current selection. `HomeHero` hides the trigger entirely when
  no directory is linked, since the panel would have nothing to offer.

Tests: `apps/web/tests/components/DesignSystemsSection.hosted-hint.test.tsx`
(hosted / same-machine / GitHub+shadcn sources) and
`apps/web/tests/components/WorkingDirPicker.hosted.test.tsx` (picker row vs
note, recents still usable).

## 7. No `basePath` support — fixed

`apps/web/next.config.ts` sets neither `basePath` nor `assetPrefix`. The build
assumes it is mounted at `/`: every chunk is `/_next/…`, the router owns `/`,
and a reverse proxy that publishes it under `https://host/od/` serves a blank
page and 404s on every asset.

`apps/web/next.config.ts` now sets `basePath` from `OD_WEB_BASE_PATH`, so
`https://host/od/` works without touching a single link: Next prefixes its own
routes, chunks and assets from that value and the host mounts `out/` at the base
path. Unset (the default) keeps `/`. The `apiBase` resolver already tolerates a
path prefix, so a split origin can be `https://api.example.com/od` too.

---

## 8. The editor hand-off surface spawns on the daemon — fixed

Every entry in `apps/daemon/src/routes/host-tools.ts` is a process launch on the
daemon host: `xdg-open` for the file manager, `/usr/bin/open -a` for macOS app
bundles, `explorer` on Windows, `cursor`/`code`/`zed`/… for editors. The daemon
advertised the whole catalogue to every peer, so a hosted browser got a
hand-off menu listing programs installed on the *server*, and clicking one
either launched something on the server's desktop or answered
`409 EDITOR_NOT_AVAILABLE "<label> is not installed"` — which reads like a
broken install rather than a deployment property.

`GET /api/editors` now answers `{ editors: [], platform: 'unknown' }` to a peer
that is not on the daemon's machine, which is exactly the shape the client
already treats as "no hand-off surface" (the zero-launchable-editors branch),
and `POST /api/projects/:id/open-in` answers
`501 HANDOFF_UNAVAILABLE` instead of spawning. Locality is decided by
`apps/daemon/src/http/host-locality.ts` — the same helper the capability probe
uses, so `OD_HOSTED=1` covers the local-reverse-proxy case once.

`POST /api/system/open-external` is the same class and needed its own answer,
because the failure was silent rather than loud: it launched the URL in the
*server's* browser, answered `200`, and `openExternalUrl` therefore returned
`true` and never ran its `location.assign` fallback — the click did nothing and
nothing explained why. It keeps the existing cross-origin `403` (a same-machine
page from another origin must not drive it) and now adds `501
OPEN_EXTERNAL_UNAVAILABLE` for a remote peer, which is exactly what makes the
client's own navigation happen.

---

## 9. `requireLocalDaemonRequest` rejects every proxy-shaped `Host` — fixed

The routes that mutate daemon-local state — the whole library (`/api/library/*`),
every connector grant (`/api/connectors/*`), `/api/daemon/db/*`, `/api/daemon/shutdown`,
the strategy-rollout routes and the memory writer — are mounted behind
`apps/daemon/src/http/local-daemon-request.ts`. It demanded three things: a
loopback peer, a loopback `Host`, and a loopback `Origin`.

The first is true behind a proxy on the same host; the other two are not. nginx
forwards `Host: od.example.com` (and `Origin: https://od.example.com`), so every
one of those routes answered `403 "request host must be a loopback daemon
address"` on **shape B, the shape this repo documents as recommended**.

Measured on this box while the register was being written: `GET
/api/library/connection` with the same session cookie answers `200` straight to
`127.0.0.1:7456` and `403` through the proxied origin.

What the check really defends is DNS rebinding, and a rebound page sends *its
own* hostname and origin — never an allowlisted one. So a declared
`OD_ALLOWED_ORIGINS` entry now counts as naming this daemon, in both headers,
which is exactly the rule `isLocalSameOrigin` already used for the 25 routes
that call it. A peer that is not loopback additionally has to present a
declared origin, so a forged loopback `Origin` from elsewhere buys nothing.

---

## 10. Unlock attempts were bucketed per proxy socket — fixed

`POST /api/auth/session` rate-limits failed unlocks to 10 per 5 minutes, keyed on
`req.socket.remoteAddress`. Behind a proxy that address is the proxy's, so one
browser's ten typos locked **everybody** out for five minutes, and an
unauthenticated attacker on the internet could take the login surface down with
ten requests — a DoS for the price of a for-loop.

The key is now the client address the trusted proxy appended to
`X-Forwarded-For` (the last entry — everything to its left is client-supplied),
and only when the peer can plausibly be that proxy: loopback, or an explicit
`OD_TRUSTED_PROXIES` entry. A direct caller cannot forge its way into a fresh
bucket. Covered by `apps/daemon/tests/daemon-session.test.ts`, including a
server whose peer is forced non-loopback to prove the header is ignored there.

---

## 11. The unlock rate-limit table grew forever — fixed

Buckets expired *logically* (a window of five minutes) but nothing removed the
entries, and the key comes from a client address. On a public login endpoint an
address-rotating client — free with IPv6 privacy addresses, cheap with a botnet —
added one permanent entry per attempt to a process meant to run for weeks.

`pruneAttemptBuckets` (`apps/daemon/src/http/attempt-buckets.ts`) drops expired
buckets and, under pressure, evicts the soonest-expiring ones down to a hard cap.
Eviction can only shorten a lockout, never extend it, so the failure mode is
availability rather than memory. The route sweeps every 256 new buckets, so the
cost is amortised. Covered by `apps/daemon/tests/attempt-buckets.test.ts`.

---

## What is verified working

- CORS + preflight for `OD_ALLOWED_ORIGINS` on `/api`, `/artifacts`,
  `/plugins/previews` and `/frames` (`apps/daemon/src/http/cors-allowlist.ts`,
  mounted before the origin guard so `OPTIONS` terminates instead of 404ing).
  A preflight from an allow-listed origin answers `204` with
  `access-control-allow-origin` and `allow-credentials` even though it carries
  no credentials (`tests/api-token-guard.test.ts`).
- The session exchange end to end against a real server, with the peer forced
  non-loopback: `POST /api/auth/session` → cookie → `GET /api/plugins` 200,
  `GET /` serves the shell, forged cookie 401, wrong token 401.
- The origin guard itself (`apps/daemon/src/origin-validation.ts`): a browser
  origin that is not listed is rejected even if CORS would have allowed the
  read.
- Loopback peers bypass the token guard, which is what keeps the desktop shell
  and the `od` CLI working.
- Static export (`output: 'export'`, `trailingSlash: true`) plus a
  `try_files … /index.html` fallback on the host — deep links land on the SPA
  shell.
- Daemon-owned subresources (`/api/…`, `/artifacts/…`, `/frames/…`,
  `/plugins/…`) written straight into the DOM are moved to the daemon origin
  before the browser fetches them, and non-daemon values are left alone
  (`tests/runtime/api-origin-subresources.test.ts`).
- `GET /api/host-capabilities` reports the same set from a loopback peer and
  from a forced non-loopback one (`apps/daemon/tests/host-capabilities.test.ts`);
  `OD_HOSTED=1` forces the remote answer when a local proxy hides the browser.
- `GET /api/editors` returns the real catalogue locally and
  `{ editors: [], platform: 'unknown' }` to a remote peer, and `/open-in`
  answers `501 HANDOFF_UNAVAILABLE` there (same test file).
- An expiring session does not strand the app, in **either** shape: a 401 from a
  daemon request re-opens the unlock form *over* the running workspace
  (`apps/web/tests/components/DaemonAuthGate.test.tsx`), the form speaks the
  user's locale, and the exchange endpoint's own 401 never triggers it. The
  report is installed even with no `apiBase` configured — a reverse-proxied
  same-origin deployment has the same 12 h cookie and no rewriting at all.
- A proxy-shaped `Host`/`Origin` pair declared in `OD_ALLOWED_ORIGINS` reaches
  `GET /api/library/connection` with `200`, while a rebound host is still
  `403` — end to end against a real server
  (`apps/daemon/tests/host-capabilities.test.ts`), plus the full
  peer/host/origin matrix in `apps/daemon/tests/local-daemon-request.test.ts`.
