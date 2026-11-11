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
| 1 | The web bundle has no way to send `OD_API_TOKEN` | P0 | B (token, no proxy auth), C |
| 2 | `EventSource` cannot carry an `Authorization` header | P0 | C |
| 3 | Preview documents forbid being framed cross-origin | ~~P0~~ **fixed** | C |
| 4 | Browser-native subresource loads bypass the URL rewriter | P1 | C |
| 5 | `/api/dialog/open-folder` is loopback/same-origin only | P1 | B, C |
| 6 | Local-filesystem endpoints assume browser and daemon share a machine | P1 | B, C |
| 7 | No `basePath` support for serving the build under a sub-path | P2 | B, C |

## 1. The web bundle has no way to send `OD_API_TOKEN` — P0

`apps/daemon/src/api-token-auth.ts` accepts exactly two credentials: a Bearer
token, or HTTP Basic with username `open-design` and the token as the password.
The guard in `apps/daemon/src/server.ts` (`if (apiTokenAuthEnabled)`) applies it
to every `/api/*` request except the health probes, and exempts loopback peers.

`apps/web/src/runtime/api-origin.ts` rewrites *URLs*. Nothing in `apps/web/src`
builds a daemon credential — grep the tree for `Authorization` and every hit is
a model-provider key, not the daemon's.

So with `OD_API_TOKEN` set and the browser on a non-loopback path:

- every `fetch` fails with `401 {"code":"API_TOKEN_REQUIRED"}`;
- the Basic challenge is not a rescue: browsers present the credential dialog
  for *navigations and subresources*, not for a cross-origin `fetch`, which
  hands the 401 back to JS.

Shape B avoids this today only because nginx terminates auth and the daemon
sees a loopback peer — i.e. the token story is unused, not working.

**Fix**: mint a session instead of passing the token through the app. Add
`POST /api/auth/session` (rate-limited, token in the body) that sets
`Set-Cookie: od_session=<opaque>; HttpOnly; SameSite=Lax|None; Secure; Path=/`,
accept the cookie in the same guard, and have the web show a one-field unlock
screen when `GET /api/version` answers 401. Cookie auth also fixes gaps 2 and 4
for free, because the browser attaches it to every same-site request including
`EventSource` and `<img>`. The cheaper alternative — accept `?od_token=` on
GET/HEAD and append it from the runtime config — works for gap 2 and 4 but puts
the secret in URLs, so it should be a documented opt-in, never the default.

## 2. `EventSource` cannot carry an `Authorization` header — P0

Four live surfaces stream over SSE and all of them construct `EventSource`
directly: `components/LibrarySection.tsx`, `components/MemorySection.tsx`,
`components/MemoryToast.tsx`, `components/workspace/TerminalViewer.tsx` (plus
the chat/run streams inside `providers/registry.ts`). The `EventSource` spec has
no per-request headers; `withCredentials` only adds cookies.

With a base set, the rewriter moves these onto the daemon origin, so they fail
cross-origin *and* unauthenticated: chat, run logs, terminal and memory all go
silent.

**Fix**: covered by the cookie session in gap 1. If the token-in-query route is
taken instead, the rewriter must append it to `EventSource` URLs specifically.

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

## 4. Browser-native subresource loads bypass the URL rewriter — P1

`rewriteApiUrl` only sees `fetch`, `Request` and `EventSource`. Anything the
markup loads directly — `<img src="/artifacts/…">`, `<video poster>`,
`<link rel="stylesheet" href="/api/…">`, an `<iframe>` whose `src` came from a
string the app did not build through `fetch` — resolves against the *web*
origin and 404s there.

Measured: 25 places in `apps/web/src` return a template literal starting with
`/api/` (asset and thumbnail builders), and `workspaceResourceUrl` has 29 call
sites that deliberately stay relative.

**Fix**: either route every one of those through a single
`apiResourceUrl(path)` export of `api-origin.ts`, or install a
`MutationObserver` on `src` / `href` / `poster` / `srcset` that applies
`rewriteApiUrl` to the five daemon prefixes. The rewriter is the smaller diff
and survives rebases; the helper is more predictable. Do one, not both.

## 5. `/api/dialog/open-folder` is loopback/same-origin only — P1

`apps/daemon/src/routes/media.ts` guards the picker with
`isLocalSameOrigin(req, getResolvedPort())` and otherwise answers
`403 cross-origin request rejected`. The web calls it unconditionally
(`state/projects.ts` `pickLocalFolderPath`, also `state/project-locations.ts`
and `providers/registry.ts`), so in a hosted deployment the "Choose folder"
action always fails — with a message that reads like a bug rather than a
deployment property.

It also cannot be made to work as-is: the dialog would appear on the *daemon's*
desktop, and the path it returns is meaningful only to the daemon.

**Fix**: answer `501 FOLDER_PICKER_UNAVAILABLE` with that explanation, and have
`useOpenFolderImport` fall back to a text field for the server-side path (the
import route already takes a path string, so the picker is only sugar).

## 6. Local-filesystem endpoints assume one machine — P1

Same class, no crash, but the UI promises something the deployment cannot
deliver:

| Endpoint | Assumption |
|---|---|
| `POST /api/dir-exists` | the typed path exists on the daemon host |
| `POST /api/design-systems/import/local` | the folder is on the daemon host |
| `POST /api/plugins/upload-folder` | the folder is on the daemon host |
| `POST /api/agents/:agentId/oauth-launch` | a desktop session exists for `agy` |
| `GET /api/projects/:id/files` | the project tree is local-readable |

**Fix**: a capability probe the web reads at boot (`GET /api/host-capabilities`)
that reports `folderPicker`, `localFolders`, `systemTerminal`, and hide/relabel
the affordances instead of letting them 403. Cheaper interim: label the path
fields "path on the server".

## 7. No `basePath` support — P2

`apps/web/next.config.ts` sets neither `basePath` nor `assetPrefix`. The build
assumes it is mounted at `/`: every chunk is `/_next/…`, the router owns `/`,
and a reverse proxy that publishes it under `https://host/od/` serves a blank
page and 404s on every asset.

**Fix**: `basePath: process.env.OD_WEB_BASE_PATH` (Next rewrites `Link`/router
and static paths for us) and mention it in the README's shape B section. The
`apiBase` resolver already tolerates a path prefix.

---

## What is verified working

- CORS + preflight for `OD_ALLOWED_ORIGINS` on `/api`, `/artifacts`,
  `/plugins/previews` and `/frames` (`apps/daemon/src/http/cors-allowlist.ts`,
  mounted before the origin guard so `OPTIONS` terminates instead of 404ing).
- The origin guard itself (`apps/daemon/src/origin-validation.ts`): a browser
  origin that is not listed is rejected even if CORS would have allowed the
  read.
- Loopback peers bypass the token guard, which is what keeps the desktop shell
  and the `od` CLI working.
- Static export (`output: 'export'`, `trailingSlash: true`) plus a
  `try_files … /index.html` fallback on the host — deep links land on the SPA
  shell.
