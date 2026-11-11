import { useEffect, useState } from 'react';

import { fetchHostCapabilities, type HostCapabilities } from '../runtime/host-capabilities';

/**
 * `null` while the probe is in flight. Callers keep an affordance visible unless
 * the daemon has answered that it cannot serve it, so a slow probe never makes
 * the UI flicker and a failed probe leaves the desktop behaviour intact.
 */
export function useHostCapabilities(): HostCapabilities | null {
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchHostCapabilities().then((caps) => {
      if (alive) setCapabilities(caps);
    });
    return () => {
      alive = false;
    };
  }, []);

  return capabilities;
}
