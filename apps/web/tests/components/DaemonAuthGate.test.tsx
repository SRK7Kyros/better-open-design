// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DaemonAuthGate } from '../../src/components/DaemonAuthGate';
import { probeDaemonSession } from '../../src/runtime/daemon-session';

vi.mock('../../src/runtime/daemon-session', () => ({
  probeDaemonSession: vi.fn(),
  unlockDaemon: vi.fn(),
}));

const probe = vi.mocked(probeDaemonSession);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
