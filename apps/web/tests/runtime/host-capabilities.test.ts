import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchHostCapabilities,
  resetHostCapabilitiesCache,
} from '../../src/runtime/host-capabilities';

const LOCAL = {
  sameMachine: true,
  folderPicker: true,
  localFolders: true,
  systemTerminal: true,
};

describe('host capabilities', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetHostCapabilitiesCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetHostCapabilitiesCache();
  });

  const respond = (body: unknown, ok = true) => {
    fetchMock.mockResolvedValue({ ok, json: async () => body });
  };

  it('reports what a remote daemon cannot do', async () => {
    respond({ ok: true, sameMachine: false, folderPicker: false, localFolders: false, systemTerminal: false });

    expect(await fetchHostCapabilities()).toEqual({
      sameMachine: false,
      folderPicker: false,
      localFolders: false,
      systemTerminal: false,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/host-capabilities', { cache: 'no-store' });
  });

  it('defaults to the local capability set when the probe fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(await fetchHostCapabilities()).toEqual(LOCAL);
  });

  it('defaults to the local set when the daemon answers without the shape', async () => {
    respond({ ok: true, sameMachine: 'no' });
    expect(await fetchHostCapabilities()).toEqual(LOCAL);

    resetHostCapabilitiesCache();
    respond({}, false);
    expect(await fetchHostCapabilities()).toEqual(LOCAL);
  });

  it('probes once per page load', async () => {
    respond({ ok: true, sameMachine: false, folderPicker: false, localFolders: false, systemTerminal: false });

    await fetchHostCapabilities();
    await fetchHostCapabilities();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resetHostCapabilitiesCache();
    await fetchHostCapabilities();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
