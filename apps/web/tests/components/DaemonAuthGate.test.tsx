// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DaemonAuthGate } from '../../src/components/DaemonAuthGate';
import { DAEMON_UNAUTHORIZED_EVENT, probeDaemonSession, unlockDaemon } from '../../src/runtime/daemon-session';

vi.mock('../../src/runtime/daemon-session', () => ({
  DAEMON_UNAUTHORIZED_EVENT: 'od-daemon-unauthorized',
  probeDaemonSession: vi.fn(),
  unlockDaemon: vi.fn(),
}));

const probe = vi.mocked(probeDaemonSession);
const unlock = vi.mocked(unlockDaemon);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('DaemonAuthGate', () => {
  it('renders the app when the daemon needs no session', async () => {
    probe.mockResolvedValue({ required: false, authenticated: true });
    render(<DaemonAuthGate><p>app mounted</p></DaemonAuthGate>);
    await waitFor(() => expect(screen.queryByText('app mounted')).not.toBeNull());
    expect(screen.queryByLabelText(/access token/i)).toBeNull();
  });

  it('renders the app when the browser already holds a session', async () => {
    probe.mockResolvedValue({ required: true, authenticated: true });
    render(<DaemonAuthGate><p>app mounted</p></DaemonAuthGate>);
    await waitFor(() => expect(screen.queryByText('app mounted')).not.toBeNull());
  });

  it('asks for the token when the daemon requires one and the browser has none', async () => {
    probe.mockResolvedValue({ required: true, authenticated: false });
    render(<DaemonAuthGate><p>app mounted</p></DaemonAuthGate>);
    await waitFor(() => expect(screen.queryByLabelText(/access token/i)).not.toBeNull());
    expect(screen.queryByText('app mounted')).toBeNull();
    expect(screen.getByRole('button', { name: /unlock/i })).toHaveProperty('disabled', true);
  });

  it('never blocks the app when the probe itself fails', async () => {
    probe.mockResolvedValue(null);
    render(<DaemonAuthGate><p>app mounted</p></DaemonAuthGate>);
    await waitFor(() => expect(screen.queryByText('app mounted')).not.toBeNull());
  });
});

describe('DaemonAuthGate after the session expires', () => {
  it('asks for the token again without unmounting the app', async () => {
    probe.mockResolvedValueOnce({ required: true, authenticated: true });
    probe.mockResolvedValue({ required: true, authenticated: false });
    unlock.mockResolvedValue({ ok: true });

    render(<DaemonAuthGate><p>app mounted</p></DaemonAuthGate>);
    await waitFor(() => expect(screen.queryByText('app mounted')).not.toBeNull());

    window.dispatchEvent(new Event(DAEMON_UNAUTHORIZED_EVENT));

    await waitFor(() => expect(screen.queryByLabelText(/access token/i)).not.toBeNull());
    // The running workspace stays mounted under the overlay: an expiring cookie
    // must not throw away the conversation the user was in the middle of.
    expect(screen.queryByText('app mounted')).not.toBeNull();

    fireEvent.change(screen.getByLabelText(/access token/i), {
      target: { value: 'od_pat_test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    await waitFor(() => expect(screen.queryByLabelText(/access token/i)).toBeNull());
    expect(unlock).toHaveBeenCalledWith('od_pat_test');
    expect(screen.queryByText('app mounted')).not.toBeNull();
  });

  it('ignores a stray 401 when the daemon needs no session', async () => {
    probe.mockResolvedValueOnce({ required: true, authenticated: true });
    probe.mockResolvedValue({ required: false, authenticated: true });

    render(<DaemonAuthGate><p>app mounted</p></DaemonAuthGate>);
    await waitFor(() => expect(screen.queryByText('app mounted')).not.toBeNull());

    window.dispatchEvent(new Event(DAEMON_UNAUTHORIZED_EVENT));
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText(/access token/i)).toBeNull();
  });
});

describe('DaemonAuthGate overlay locale', () => {
  it('re-opens the form in the language the user picked', async () => {
    // The gate lives outside <App>, so its overlay needs its own provider;
    // without one the form would silently fall back to English.
    window.localStorage.setItem('open-design:locale', 'it');
    // `detectInitialLocale` only trusts a stored pick tagged as manual; an
    // untagged value is treated as a legacy auto-detection.
    window.localStorage.setItem('open-design:locale-source', 'manual');
    probe.mockResolvedValueOnce({ required: true, authenticated: true });
    probe.mockResolvedValue({ required: true, authenticated: false });

    render(<DaemonAuthGate><p>app mounted</p></DaemonAuthGate>);
    await waitFor(() => expect(screen.queryByText('app mounted')).not.toBeNull());

    window.dispatchEvent(new Event(DAEMON_UNAUTHORIZED_EVENT));

    await waitFor(() => expect(screen.queryByText(/Sblocca/)).not.toBeNull());
    expect(screen.queryByText(/Unlock/)).toBeNull();
  });
});
