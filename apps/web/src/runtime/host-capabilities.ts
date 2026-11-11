/**
 * What this deployment can actually do, as opposed to what the UI assumes.
 *
 * The desktop build and a same-machine daemon can open a native folder picker,
 * stat a path the user typed, and spawn a system terminal. A daemon behind a
 * reverse proxy or on another origin cannot do any of that: the dialog would
 * appear on the server's desktop and the paths belong to the server's disks.
 *
 * `GET /api/host-capabilities` answers from the daemon's own view of the peer,
 * so the client can relabel or hide those affordances instead of letting the
 * user hit a 501/403 after typing.
 */

export interface HostCapabilities {
  sameMachine: boolean;
  folderPicker: boolean;
  localFolders: boolean;
  systemTerminal: boolean;
}

const LOCAL: HostCapabilities = {
  sameMachine: true,
  folderPicker: true,
  localFolders: true,
  systemTerminal: true,
};

let cached: Promise<HostCapabilities> | null = null;

function coerce(value: unknown): HostCapabilities | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sameMachine !== 'boolean') return null;
  return {
    sameMachine: record.sameMachine,
    folderPicker: record.folderPicker === true,
    localFolders: record.localFolders === true,
    systemTerminal: record.systemTerminal === true,
  };
}

/**
 * Resolves to the local capability set when the probe fails, because hiding a
 * working affordance is worse than one failed click: a transient network error
 * must not turn a desktop build into a read-only page.
 */
export function fetchHostCapabilities(): Promise<HostCapabilities> {
  cached ??= fetch('/api/host-capabilities', { cache: 'no-store' })
    .then(async (resp) => (resp.ok ? coerce(await resp.json()) : null))
    .then((caps) => caps ?? LOCAL)
    .catch(() => LOCAL);
  return cached;
}

export function resetHostCapabilitiesCache(): void {
  cached = null;
}
