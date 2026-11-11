# better-open-design

An opinionated fork of [OpenDesign](https://github.com/nexu-io/open-design) for people who
run it as **a web app on a server**, not as a desktop app on a laptop.

Upstream is genuinely good: it detects your installed coding agent, runs design skills and
design systems, and streams the result into a sandboxed preview. Its operating assumption,
though, is that the daemon, the web UI, the browser and your editor all live on the same
machine, started by a desktop shell. The moment you host it — a box in a rack, a tailnet, a
VPS behind nginx — that assumption shows up as a series of small, sharp edges:

* a preview panel that stays **black** for any artifact that routes against `location`,
  because the host heuristic picks the `srcDoc` transport and a `srcdoc` frame has an opaque
  origin (`about:srcdoc`), so `new URL('/', location.href)` throws before React mounts;
* a **hand-off button that can only fail**: with no editor on `$PATH` it offers the OS file
  manager, which a headless host does not have, so every click is a `409` and a toast;
* a web bundle that is **only deployable next to its daemon**, because every API call is a
  relative `/api/…` fetch and no origin can be configured;
* cloud sign-in that, when the `vela` CLI is missing, leaves the onboarding pane in a busy
  state that **swallows clicks** on the local-AI alternatives underneath it.

This fork keeps the product and fixes the hosting story. Nothing here is a rewrite: the UI,
the daemon, the agent integration and the storage model are upstream's. The differences are
in where the boundary between the browser and the server is drawn, and in what the client
does when the host behind it cannot satisfy a desktop-only capability.

## What this fork changes

### Preview transport: a real origin when the document needs one

`FileViewer` chooses between URL-load (`<iframe src=…>`) and inline `srcDoc`. Upstream picks
`srcDoc` when the artifact merely mentions `localStorage`, and when the source contains the
substring `<form` — which React Router ships inside a dev-warning string. Both are wrong for
router-based SPAs, and the result is a blank panel with no error visible to the user.

* `htmlNeedsRealOrigin()` (`apps/web/src/components/file-viewer-render-mode.ts`) detects the
  documents that genuinely require a real origin: `new URL(…, location.href)`,
  `location.origin` / `location.pathname`, and `createBrowserRouter` / `createHashRouter`.
  Those stay on URL-load even when they use `localStorage`.
* The `<form` heuristic now requires a closing `</form>` before it forces `srcDoc`.

An artifact that only uses storage keeps upstream's behaviour. An artifact that cannot run
in a `srcdoc` frame is no longer sent there.

### Hand-off degrades instead of lying

When `/api/editors` reports nothing launchable, the hand-off surface renders **nothing**.
Upstream renders a "File Manager" fallback button that on a server host resolves to `xdg-open`
— which is not installed — so the button exists only to produce an error toast. A button that
can never work is worse than no button; the CLI hand-off prompt (copy the project path and a
framework-specific instruction into your agent) stays available.

### Same-origin by default, configurable by environment

The web build no longer assumes the daemon is on `127.0.0.1:7456`:

| Variable | Side | Effect |
|---|---|---|
| `OD_DAEMON_ORIGIN` | web dev/proxy | where `next dev` proxies `/api`, `/artifacts`, `/frames`, `/plugins` |
| `NEXT_PUBLIC_OD_API_BASE` | web build | absolute daemon base baked into the bundle |
| `OD_ALLOWED_ORIGINS` | daemon | browser origins allowed to call `/api` **and** to read the response (new: CORS headers + preflight) |

Three deployment shapes are documented in [`deploy/web/`](deploy/web/README.md): the upstream
single process, a reverse proxy in front of the daemon (recommended for self-hosting), and a
genuinely split origin where the static build names its backend at runtime.

The runtime override is also editable **after** the build, which matters for static hosting:

```html
<meta name="od-api-base" content="https://od-api.example.com" />
```

Resolution order is `window.__OD_CONFIG__.apiBase` → that meta tag → `NEXT_PUBLIC_OD_API_BASE`
→ same origin. Unset means upstream's behaviour, byte for byte, so this fork's changes are
inert on a stock desktop install.

## Run it

Prerequisites: Node 22+, pnpm 10 (`corepack enable` or `bunx pnpm@10.33.2`), and an agent CLI
on `$PATH` (optional — the BYOK proxy path works without one).

```bash
pnpm install --frozen-lockfile

# web + daemon, upstream's dev-all launcher
pnpm tools-dev

# or split them, which is the point of this fork:
od --no-open --port 7456                       # backend
OD_DAEMON_ORIGIN=http://127.0.0.1:7456 \
  pnpm --filter @open-design/web dev           # frontend, any port
```

Production static build:

```bash
pnpm --filter @open-design/web build           # → apps/web/out
```

Then follow [`deploy/web/README.md`](deploy/web/README.md).

## Tests

The changes above are covered by tests in the same suites upstream uses:

```bash
pnpm --filter @open-design/web test     # render-mode, hand-off, api-origin
pnpm --filter @open-design/daemon test  # cors-allowlist, origin-validation
```

### The suites are large — shard them, and use the parallel config

There is no aggregate `test` script at the root; "run the tests" means the two
commands above, over 1421 web files (~13.1k cases) and 1062 daemon files
(~11.8k cases), with `e2e/` (134 files) and the Playwright groups on top. CI
never runs that as one job: `ci.yml` shards daemon 4× (15 min budget each) and
web 2× (20 min), and `.github/scripts/scopes.py` / `convergence.py` skip or
reuse workloads whose paths did not change.

Measured on a 4-core ARM VM (one shard of each, `--shard=1/4`):

| Suite | Files / cases | Wall clock | Full suite |
|---|---|---|---|
| `apps/web`, `--maxWorkers=2` | 356 / 3938 | 416 s | ~28 min (4 shards) |
| `apps/daemon`, serial config | 266 / 4025 | 1142 s, 2 red | ~76 min (4 shards) |
| `apps/daemon`, `vitest.parallel.config.ts`, 3 workers | 266 / 4025 | 485 s shard 1, 322–347 s shards 2–4 | **1491 s ≈ 25 min, all four shards green** |

`apps/daemon` defaults to one file at a time (`fileParallelism: false`) because
its suites mutate `process.env` / `PATH` and bind real servers. Upstream also
ships `apps/daemon/vitest.parallel.config.ts`, and
`.github/actions/configure-ci-parallelism` exports `OD_CI_DAEMON_MAX_WORKERS`
for it — but nothing has ever passed `-c vitest.parallel.config.ts`, so the fast
config was unreachable. This fork wires it up:

```bash
pnpm --filter @open-design/daemon test:parallel      # whole suite, parallel
# or one shard, sized from nproc:
OD_CI_DAEMON_MAX_WORKERS=3 pnpm --filter @open-design/daemon exec vitest \
  run -c vitest.parallel.config.ts --shard=1/4
```

The parallel config also removes a flake: serial runs put every file in the same
worker, so a leftover diagnostics write made `workspace-context-authority-server-wiring`
fail its `rm` teardown in full-suite runs (green standalone, 13/13). Its teardown
now restores `prom-client`'s registry and the module cache before touching the
temp tree, so a lost race can no longer cascade into "a metric ... has already
been registered" in the next case. All four shards are green under the parallel
config; the source-side race it papered over — `createDiagnosticsEvidence.close()`
does not await an in-flight checkpoint write — is still open.

## Staying rebaseable

This fork tracks upstream releases tag by tag, on a branch per review round:

```
upstream/main ──●──●──●──●  (nexu-io/open-design, tags open-design-vX.Y.Z)
                     \
                      big-bro ──●──●  (this fork: one commit per concern)
```

Rules the patches follow, so a future rebase stays mechanical:

1. **No renames, no moves, no reformatting.** A patch touches the smallest region that
   carries the bug.
2. **No new abstractions upstream would have to adopt.** The CORS middleware and the API-origin
   interceptor are additive modules; upstream files change only where the call has to be wired.
3. **Predicates stay pure and testable.** `htmlNeedsRealOrigin` is a function of the source
   string, not of viewer state, so it survives refactors around it.
4. **Behaviour is opt-in by configuration** wherever possible: an unset `OD_ALLOWED_ORIGINS`
   or an absent meta tag reproduces upstream exactly.

When a new upstream release lands, the review starts from the release tag, re-reads the four
areas above (`FileViewer` transport decision, `HandoffButton` zero-editor branch, the daemon
origin guard, `next.config.ts` rewrites), and reapplies whatever still applies. Anything the
upstream fixed natively is dropped rather than carried forward.

## License

Apache-2.0, same as upstream. This is a fork, not an official distribution; report issues
here and only report upstream-reproducible bugs upstream.
