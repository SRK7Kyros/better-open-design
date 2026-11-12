// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openFolderDialog } from '../src/providers/registry';
import { setServerPathHandler } from '../src/runtime/server-path-request';

vi.mock('../src/runtime/host-capabilities', () => ({
  fetchHostCapabilities: vi.fn(async () => ({
    sameMachine: false,
    folderPicker: false,
    localFolders: true,
    systemTerminal: false,
  })),
}));

/**
 * On a hosted daemon the dialog would open on the server's desktop, so the
 * native route is not attempted at all. The folder is still a valid answer: the
 * caller must receive the path the user typed, through exactly the same
 * `await openFolderDialog()` contract every existing callsite already uses.
 */
afterEach(() => {
  setServerPathHandler(null);
  vi.restoreAllMocks();
});

describe('openFolderDialog without a native picker', () => {
  it('returns the path the user typed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setServerPathHandler(async () => '/srv/projects/demo');

    await expect(openFolderDialog()).resolves.toBe('/srv/projects/demo');

    // No 501 request is sent for a dialog this machine cannot show.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the deployment reason as the dialog hint', async () => {
    setServerPathHandler(async (request) => {
      expect(request.hint).toMatch(/another machine/i);
      return null;
    });

    await expect(openFolderDialog()).resolves.toBeNull();
  });

  it('treats a dismissed field as a cancel, not as a failure', async () => {
    setServerPathHandler(async () => null);

    await expect(openFolderDialog({ throwOnError: true })).resolves.toBeNull();
  });

  it('keeps the throw-on-error contract when no dialog can be shown at all', async () => {
    setServerPathHandler(null);

    await expect(openFolderDialog({ throwOnError: true }))
      .rejects.toThrow(/type the folder path on the server/i);
  });
});
