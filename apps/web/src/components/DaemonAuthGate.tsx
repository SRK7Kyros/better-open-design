import { useEffect, useState, type FormEvent } from 'react';

import { I18nProvider, useI18n } from '../i18n';
import { MatrixLoader } from './MatrixLoader';
import { probeDaemonSession, unlockDaemon } from '../runtime/daemon-session';
import styles from './DaemonAuthGate.module.css';

type Phase = 'probing' | 'ready' | 'locked';

interface UnlockFormProps {
  onUnlocked: () => void;
}

function UnlockForm({ onUnlocked }: UnlockFormProps) {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const trimmed = token.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    const result = await unlockDaemon(trimmed);
    setSubmitting(false);
    if (result.ok) {
      setToken('');
      onUnlocked();
      return;
    }
    setError(result.message);
  }

  return (
    <main className={styles.shell}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <h1 className={styles.title}>{t('daemonUnlock.title')}</h1>
        <p className={styles.body}>{t('daemonUnlock.body')}</p>
        <label className={styles.label} htmlFor="od-daemon-token">
          {t('daemonUnlock.fieldLabel')}
        </label>
        <input
          id="od-daemon-token"
          className={styles.input}
          type="password"
          autoComplete="current-password"
          autoFocus
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={t('daemonUnlock.placeholder')}
        />
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <button className={styles.submit} type="submit" disabled={submitting || !token.trim()}>
          {submitting ? t('daemonUnlock.submitting') : t('daemonUnlock.submit')}
        </button>
      </form>
    </main>
  );
}

/**
 * Blocks the app until the browser holds a daemon session.
 *
 * A token-protected daemon answers every `/api` request with 401 unless the
 * request carries a credential, and a browser can only carry a cookie. Rather
 * than spend the first paint on 401s and render an app where nothing loads,
 * the shell asks `GET /api/auth/session` once and shows the unlock form when
 * the answer is "required, not authenticated".
 *
 * A failed probe (daemon down, CORS misconfigured) never blocks the app: the
 * product surfaces its own connection errors, and a second, different failure
 * screen on top of them helps nobody.
 */
export function DaemonAuthGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>('probing');

  useEffect(() => {
    let cancelled = false;
    void probeDaemonSession().then((state) => {
      if (cancelled) return;
      setPhase(state?.required === true && !state.authenticated ? 'locked' : 'ready');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === 'ready') return <>{children}</>;
  if (phase === 'probing') {
    return (
      <div className="od-loading-shell">
        <MatrixLoader />
        <span>Loading OpenDesign…</span>
      </div>
    );
  }

  return (
    <I18nProvider>
      <UnlockForm onUnlocked={() => setPhase('ready')} />
    </I18nProvider>
  );
}
