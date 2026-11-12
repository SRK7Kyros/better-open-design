import { useEffect, useState } from 'react';

import { useT } from '../i18n';
import { fetchHostCapabilities } from '../runtime/host-capabilities';

/**
 * The sentence under the activation link, shared by all three sign-in entry
 * points (settings, home, onboarding), so a copy change lands everywhere at
 * once.
 *
 * `browserOpenFailed` is real only when the browser it tried to open is on the
 * user's own desk. A hosted daemon runs `vela login` on the server, which has no
 * browser to open, so it reports that flag on every single sign-in — and the
 * "Couldn't open the sign-in page — please try signing in again" copy then sent
 * people into a retry that could never succeed while the working link sat next
 * to it. `GET /api/host-capabilities` is what separates the two deployments.
 */
export function AmrActivationHintText({ browserOpenFailed }: { browserOpenFailed: boolean }) {
  const t = useT();
  const [sameMachine, setSameMachine] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchHostCapabilities().then((capabilities) => {
      if (!cancelled) setSameMachine(capabilities.sameMachine);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!browserOpenFailed || !sameMachine) return <>{t('settings.amrActivationHint')}</>;
  return (
    <>
      <span className="amr-login-activation__title">{t('settings.amrActivationBrowserFailedTitle')}</span>
      <span className="amr-login-activation__body">{t('settings.amrActivationBrowserFailedDescription')}</span>
    </>
  );
}
