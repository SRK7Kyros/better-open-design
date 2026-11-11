// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary } from '@open-design/contracts';

import { DesignSystemsSection } from '../../src/components/DesignSystemsSection';
import type { AppConfig } from '../../src/types';
import type { HostCapabilities } from '../../src/runtime/host-capabilities';

// A daemon reached through a reverse proxy: the folder it would import belongs
// to the server's disk, not to the machine running this browser.
const HOSTED: HostCapabilities = {
  sameMachine: false,
  folderPicker: false,
  localFolders: false,
  systemTerminal: false,
};

const capabilities = vi.hoisted(() => ({ current: null as HostCapabilities | null }));
vi.mock('../../src/hooks/useHostCapabilities', () => ({
  useHostCapabilities: () => capabilities.current,
}));

const existing: DesignSystemSummary = {
  id: 'user:acme',
  title: 'Acme Design System',
  category: 'Custom',
  summary: 'Internal product system.',
  surface: 'web',
  source: 'user',
  status: 'draft',
  isEditable: true,
  updatedAt: '2026-05-13T03:19:00.000Z',
};

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchDesignSystems: vi.fn(async () => [existing]),
    updateDesignSystemDraft: vi.fn(async () => null),
  };
});

afterEach(() => {
  cleanup();
  capabilities.current = null;
  vi.clearAllMocks();
});

const cfg = { disabledDesignSystems: [] } as unknown as AppConfig;

function openLocalImport(): void {
  render(<DesignSystemsSection cfg={cfg} setCfg={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /Add design system/i }));
}

describe('DesignSystemsSection local import path', () => {
  it('says the path is read on the daemon when the picker is unavailable', () => {
    capabilities.current = HOSTED;
    openLocalImport();

    expect(screen.queryByText(/read on the daemon's machine/i)).not.toBeNull();
  });

  it('stays quiet on a same-machine daemon, where the path is the user already knows', () => {
    capabilities.current = {
      sameMachine: true,
      folderPicker: true,
      localFolders: true,
      systemTerminal: true,
    };
    openLocalImport();

    expect(screen.queryByText(/read on the daemon's machine/i)).toBeNull();
  });

  it('hides the note for the GitHub and shadcn sources, which need no disk path', () => {
    capabilities.current = HOSTED;
    openLocalImport();

    fireEvent.click(screen.getByRole('button', { name: /^GitHub$/i }));
    expect(screen.queryByText(/read on the daemon's machine/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^shadcn$/i }));
    expect(screen.queryByText(/read on the daemon's machine/i)).toBeNull();
  });
});
