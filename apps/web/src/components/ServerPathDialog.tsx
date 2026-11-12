import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@open-design/components';

import { useT } from '../i18n';
import styles from './ServerPathDialog.module.css';

interface Props {
  /** Why a native picker is not being used; defaults to the hosted explanation. */
  hint?: string;
  /** Path being replaced, so the field opens on the current value. */
  initialValue?: string;
  onCancel: () => void;
  onSubmit: (path: string) => void;
}

/**
 * Absolute-path shapes the daemon can actually resolve: POSIX (`/x`), Windows
 * drive (`C:\x` or `C:/x`) and UNC (`\\host\share`). A relative path would be
 * resolved against the daemon's own cwd, which is never what the user means.
 */
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/;

/**
 * Asks for a folder that lives on the machine running the daemon.
 *
 * This exists because the native picker cannot: it would open a dialog on the
 * server's desktop and return a path only the server understands. Typing the
 * path is the one input that survives the split, and it is validated for shape
 * here — whether the folder exists is the daemon's answer to give, and its
 * `dir-exists` probe is same-origin only.
 */
export function ServerPathDialog({ hint, initialValue = '', onCancel, onSubmit }: Props) {
  const t = useT();
  const titleId = useId();
  const inputId = useId();
  const hintId = useId();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const path = value.trim();
    if (!path) return;
    if (!ABSOLUTE_PATH.test(path)) {
      setError(t('folderPath.invalid'));
      return;
    }
    setError(null);
    onSubmit(path);
  }

  const dialog = (
    <Dialog
      as="form"
      className={styles.dialog}
      onSubmit={submit}
      onClose={onCancel}
      ariaLabelledBy={titleId}
      ariaDescribedBy={hintId}
      data-testid="server-path-dialog"
    >
      <DialogTitle id={titleId}>{t('folderPath.title')}</DialogTitle>
      <DialogDescription id={hintId} className={styles.hint}>
        {hint ?? t('folderPath.hint')}
      </DialogDescription>
      <label className={styles.label} htmlFor={inputId}>
        {t('folderPath.label')}
      </label>
      <input
        id={inputId}
        className={styles.input}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          if (error) setError(null);
        }}
        placeholder={t('folderPath.placeholder')}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoFocus
        data-testid="server-path-input"
      />
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <DialogFooter className={styles.actions}>
        <Button type="button" variant="default" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={value.trim().length === 0}
          data-testid="server-path-submit"
        >
          {t('folderPath.confirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
  if (typeof document === 'undefined') return dialog;
  return createPortal(dialog, document.body);
}
