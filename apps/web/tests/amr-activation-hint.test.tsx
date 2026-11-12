// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AmrActivationHintText } from '../src/components/AmrActivationHintText';

const capabilities = vi.hoisted(() => ({ sameMachine: false }));

vi.mock('../src/runtime/host-capabilities', () => ({
  fetchHostCapabilities: async () => ({
    sameMachine: capabilities.sameMachine,
    folderPicker: capabilities.sameMachine,
    localFolders: capabilities.sameMachine,
    systemTerminal: capabilities.sameMachine,
  }),
}));

/**
 * `vela login` runs on the daemon's host. On a hosted deployment it can never
 * open a browser there, so it reports `browserOpenFailed` on every sign-in —
 * and the failure copy sent people into a retry that could not succeed, under
 * a link that would have worked. On a desktop daemon the same flag is real and
 * the copy is the right thing to say.
 */
afterEach(() => {
  cleanup();
  capabilities.sameMachine = false;
});

describe('AmrActivationHintText', () => {
  it('never reports a browser failure on a hosted daemon, where that is the norm', async () => {
    render(<AmrActivationHintText browserOpenFailed />);

    expect(screen.getByText(/sign-in page didn't open/i)).not.toBeNull();
    expect(screen.queryByText(/couldn’t open the sign-in page/i)).toBeNull();
    expect(screen.queryByText(/try signing in again/i)).toBeNull();
  });

  it('keeps the browser-failure copy where the browser is on the same machine', async () => {
    capabilities.sameMachine = true;
    render(<AmrActivationHintText browserOpenFailed />);

    await waitFor(() =>
      expect(screen.getByText(/couldn’t open the sign-in page/i)).not.toBeNull(),
    );
  });

  it('shows the plain hint when the daemon opened the browser itself', async () => {
    capabilities.sameMachine = true;
    render(<AmrActivationHintText browserOpenFailed={false} />);

    expect(screen.getByText(/sign-in page didn't open/i)).not.toBeNull();
  });
});
