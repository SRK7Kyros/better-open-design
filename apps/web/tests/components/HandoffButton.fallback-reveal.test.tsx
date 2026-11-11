// @vitest-environment jsdom

// Regression for the zero-editors fallback: when no editor is detected, the
// fallback button must perform a real reveal (open the project folder via the
// daemon's open-in catalogue: finder / explorer / file-manager) rather than a
// no-op that advertises an action it never runs.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HandoffButton } from '../../src/components/HandoffButton';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, HostEditorsResponse } from '@open-design/contracts';

const fetchHostEditors = vi.fn<() => Promise<HostEditorsResponse>>();
const openProjectInEditor = vi.fn();
const copyToClipboard = vi.fn();

vi.mock('../../src/providers/registry', () => ({
  fetchHostEditors: () => fetchHostEditors(),
  openProjectInEditor: (...args: unknown[]) => openProjectInEditor(...args),
}));

vi.mock('../../src/lib/copy-to-clipboard', () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboard(...args),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  fetchHostEditors.mockReset();
  openProjectInEditor.mockReset();
  copyToClipboard.mockReset();
});

describe('HandoffButton on a host with nothing to open the project', () => {
  it('renders no hand-off surface instead of a button that can only 409', async () => {
    fetchHostEditors.mockResolvedValue({
      platform: 'linux',
      editors: [
        { id: 'file-manager', label: 'File Manager', available: false },
        { id: 'cursor', label: 'Cursor', available: false },
      ],
    });

    const { container } = render(
      <I18nProvider initial="en">
        <HandoffButton projectId="p1" projectKind="prototype" />
      </I18nProvider>,
    );

    await waitFor(() => expect(fetchHostEditors).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid=handoff-wrap]')).toBeNull());
    expect(openProjectInEditor).not.toHaveBeenCalled();
    expect(screen.queryByText('File Manager')).toBeNull();
  });

  it('still renders the picker when the host reports a usable editor', async () => {
    fetchHostEditors.mockResolvedValue({
      platform: 'linux',
      editors: [{ id: 'cursor', label: 'Cursor', available: true }],
    });

    render(
      <I18nProvider initial="en">
        <HandoffButton projectId="p1" projectKind="prototype" />
      </I18nProvider>,
    );

    expect(await screen.findByTestId('handoff-trigger')).toBeTruthy();
  });

  it('copies a framework-specific CLI handoff prompt with the local project path', async () => {
    fetchHostEditors.mockResolvedValue({
      platform: 'darwin',
      editors: [
        {
          id: 'cursor',
          label: 'Cursor',
          available: true,
        },
      ],
    });
    copyToClipboard.mockResolvedValue(true);
    const agents: AgentInfo[] = [
      {
        id: 'claude',
        name: 'Claude Code',
        bin: 'claude',
        available: true,
      },
      {
        id: 'codex',
        name: 'Codex CLI',
        bin: 'codex',
        available: false,
      },
    ];

    render(
      <I18nProvider initial="zh-CN">
        <HandoffButton
          projectId="p1"
          projectKind="prototype"
          projectName="Landing"
          projectDir="/tmp/open-design/Landing"
          agents={agents}
          metricsConsent
          installationId="od-install-abc"
        />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByTestId('handoff-caret'));
    fireEvent.click(await screen.findByRole('tab', { name: '复制给 CLI' }));
    // The "OpenDesign Cloud website" link was removed from the CLI tab
    // (acceptance #101); the CLI agent cards remain the surface here.
    expect(screen.queryByRole('link', { name: /打开 OpenDesign Cloud 官网/ })).toBeNull();
    expect(screen.getByTestId('handoff-cli-item-amr').textContent).toContain('OpenDesign');
    expect(screen.getByTestId('handoff-cli-item-amr').textContent).not.toContain('未安装');
    expect(
      screen.getByTestId('handoff-cli-item-amr').compareDocumentPosition(
        screen.getByTestId('handoff-cli-item-codex'),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Vue.js' }));
    fireEvent.click(await screen.findByTestId('handoff-cli-item-claude'));

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledTimes(1));
    const prompt = copyToClipboard.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('/tmp/open-design/Landing');
    expect(prompt).toContain('Vue.js');
    expect(prompt).toContain('Claude Code');
    expect(prompt).toContain('真实可运行');
  });

  it('keeps the project path hidden behind a compact copy row', async () => {
    fetchHostEditors.mockResolvedValue({
      platform: 'darwin',
      editors: [
        {
          id: 'cursor',
          label: 'Cursor',
          available: true,
        },
      ],
    });
    copyToClipboard.mockResolvedValue(true);
    const projectDir = '/tmp/open-design/Landing';

    render(
      <I18nProvider initial="en">
        <HandoffButton
          projectId="p1"
          projectKind="prototype"
          projectName="Landing"
          projectDir={projectDir}
        />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByTestId('handoff-caret'));

    const pathRow = await screen.findByTestId('handoff-project-path');
    expect(pathRow.textContent).toContain('Copy path');
    expect(pathRow.textContent).not.toContain(projectDir);

    const copyPathButton = within(pathRow).getByRole('button', { name: 'Copy path' });
    expect(copyPathButton.getAttribute('title')).toBe(projectDir);
    fireEvent.click(copyPathButton);

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(projectDir));
  });
});
