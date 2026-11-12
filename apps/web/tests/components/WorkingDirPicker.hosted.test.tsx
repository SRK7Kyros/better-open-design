// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkingDirPicker } from '../../src/components/WorkingDirPicker';

afterEach(cleanup);

function renderPicker(props: Partial<React.ComponentProps<typeof WorkingDirPicker>> = {}) {
  const onPickDirectory = vi.fn();
  const onSelectRecent = vi.fn();
  render(
    <WorkingDirPicker
      workingDir={null}
      recentDirs={[]}
      onPickDirectory={onPickDirectory}
      onSelectRecent={onSelectRecent}
      {...props}
    />,
  );
  return { onPickDirectory, onSelectRecent };
}

function openPanel(): void {
  fireEvent.click(screen.getByTestId('working-dir-trigger'));
}

describe('WorkingDirPicker on a hosted daemon', () => {
  it('offers the native picker when the daemon can open one', () => {
    renderPicker();
    openPanel();

    expect(screen.queryByTestId('working-dir-pick')).not.toBeNull();
    expect(screen.queryByTestId('working-dir-server-note')).toBeNull();
  });

  it('keeps the pick action and points at the daemon when it cannot open one', () => {
    // `openFolderDialog` asks for a path on the daemon's machine instead of
    // ending on an explanation, so the row must keep its action and label it.
    renderPicker({ pickerAvailable: false });
    openPanel();

    expect(screen.queryByTestId('working-dir-pick')).not.toBeNull();
    expect(screen.queryByTestId('working-dir-server-note')?.textContent)
      .toMatch(/daemon's machine/i);
  });

  it('still lists recent folders and lets the user clear the selection', () => {
    const onClear = vi.fn();
    const onSelectRecent = vi.fn();
    renderPicker({
      pickerAvailable: false,
      workingDir: '/srv/projects/acme',
      recentDirs: ['/srv/projects/acme', '/srv/projects/beta'],
      onClear,
      onSelectRecent,
    });

    openPanel();
    fireEvent.click(screen.getByTestId('working-dir-recent'));
    fireEvent.click(screen.getByTitle('/srv/projects/beta'));

    expect(onSelectRecent).toHaveBeenCalledWith('/srv/projects/beta');
    expect(onClear).not.toHaveBeenCalled();
  });
});
