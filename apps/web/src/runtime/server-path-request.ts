/**
 * The seam between an async helper that needs a folder path and the modal that
 * can ask for it.
 *
 * `openFolderDialog` lives in `providers/registry.ts` and is awaited from click
 * handlers, so it cannot render anything itself. A hosted daemon cannot open a
 * native dialog on the user's desktop, and the workflow still needs a path —
 * the folder simply has to exist on the daemon's machine. The app root mounts
 * one dialog and registers it here; every helper then awaits a promise.
 *
 * With no host mounted (unit tests, a route that never rendered the shell) the
 * request resolves to null, which is exactly the old "picker unavailable"
 * answer — no caller starts depending on a global being present.
 */

export interface ServerPathRequest {
  /** Why a native picker is not in play. Rendered above the field. */
  hint?: string;
  /** Seed value, usually the path being replaced. */
  initialValue?: string;
}

type ServerPathHandler = (request: ServerPathRequest) => Promise<string | null>;

let handler: ServerPathHandler | null = null;

export function setServerPathHandler(next: ServerPathHandler | null): void {
  handler = next;
}

export function canRequestServerPath(): boolean {
  return handler !== null;
}

export function requestServerPath(request: ServerPathRequest = {}): Promise<string | null> {
  if (!handler) return Promise.resolve(null);
  return handler(request);
}
