import { useCallback, useEffect, useRef, useState } from 'react';

import { setServerPathHandler, type ServerPathRequest } from '../runtime/server-path-request';
import { ServerPathDialog } from './ServerPathDialog';

interface PendingRequest extends ServerPathRequest {
  id: number;
  resolve: (path: string | null) => void;
}

/**
 * Mounts the "type a path on the daemon's machine" modal for the whole app.
 *
 * Helpers such as `openFolderDialog` are awaited from click handlers and cannot
 * render a dialog, so they call `requestServerPath()` and this host answers.
 * Only one request can be open at a time — two folder picks racing would mean
 * two modals over the same inert background — so a second caller is answered
 * immediately instead of being silently dropped.
 */
export function ServerPathDialogHost() {
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const pendingRef = useRef<PendingRequest | null>(null);
  const nextId = useRef(1);

  const settle = useCallback((path: string | null) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending(null);
    current.resolve(path);
  }, []);

  useEffect(() => {
    setServerPathHandler((request) => {
      if (pendingRef.current) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        const next: PendingRequest = { ...request, id: nextId.current++, resolve };
        pendingRef.current = next;
        setPending(next);
      });
    });
    return () => {
      setServerPathHandler(null);
      /* The shell can unmount with a pick still open (route swap, reload). The
         caller is awaiting this promise, so leave it pending and it leaks a
         suspended click handler forever. */
      pendingRef.current?.resolve(null);
      pendingRef.current = null;
    };
  }, []);

  if (!pending) return null;
  return (
    <ServerPathDialog
      key={pending.id}
      hint={pending.hint}
      initialValue={pending.initialValue}
      onCancel={() => settle(null)}
      onSubmit={(path) => settle(path)}
    />
  );
}
