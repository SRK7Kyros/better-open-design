// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@open-design/host', () => ({
  isOpenDesignHostAvailable: () => false,
  pickAndImportHostProject: vi.fn(),
}));

vi.mock('../../src/collab/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({ context: null, failure: 'unavailable', loading: false }),
}));

import { useOpenFolderImport } from '../../src/components/useOpenFolderImport';
import { resetHostCapabilitiesCache } from '../../src/runtime/host-capabilities';

const REMOTE = {
  sameMachine: false,
  folderPicker: false,
  localFolders: false,
  systemTerminal: false,
};
const LOCAL = {
  sameMachine: true,
  folderPicker: true,
  localFolders: true,
  systemTerminal: true,
};

let fetchMock: ReturnType<typeof vi.fn>;

const respondWith = (body: unknown) => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => body });
};

beforeEach(() => {
  resetHostCapabilitiesCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetHostCapabilitiesCache();
});

describe('useOpenFolderImport on a remote daemon', () => {
  it('asks the caller for a path field instead of a picker button', async () => {
    respondWith(REMOTE);
    const hook = renderHook(() => useOpenFolderImport({ onImportFolder: vi.fn() }));

    await waitFor(() => expect(hook.result.current.manualEntry).toBe(true));
    expect(hook.result.current.available).toBe(true);
  });

  it('keeps the picker when the daemon shares the machine', async () => {
    respondWith(LOCAL);
    const hook = renderHook(() => useOpenFolderImport({ onImportFolder: vi.fn() }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(hook.result.current.manualEntry).toBe(false);
  });

  it('imports the typed server path', async () => {
    respondWith(REMOTE);
    const onImportFolder = vi.fn();
    const hook = renderHook(() => useOpenFolderImport({ onImportFolder }));

    await act(async () => {
      await hook.result.current.importFolderPath('  /srv/projects/landing  ');
    });

    expect(onImportFolder).toHaveBeenCalledExactlyOnceWith('/srv/projects/landing');
    expect(hook.result.current.importing).toBe(false);
    expect(hook.result.current.error).toBeNull();
  });

  it('ignores an empty path and reports an import failure', async () => {
    respondWith(REMOTE);
    const onImportFolder = vi.fn().mockRejectedValue(new Error('no such folder'));
    const hook = renderHook(() => useOpenFolderImport({ onImportFolder }));

    await act(async () => {
      await hook.result.current.importFolderPath('   ');
    });
    expect(onImportFolder).not.toHaveBeenCalled();

    await act(async () => {
      await hook.result.current.importFolderPath('/srv/missing');
    });
    expect(hook.result.current.error).toEqual({ message: 'no such folder' });
  });

  it('never calls the picker endpoint from the manual flow', async () => {
    respondWith(REMOTE);
    const hook = renderHook(() => useOpenFolderImport({ onImportFolder: vi.fn() }));

    await act(async () => {
      await hook.result.current.importFolderPath('/srv/projects/landing');
    });

    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toContain('/api/host-capabilities');
    expect(urls).not.toContain('/api/dialog/open-folder');
  });
});
