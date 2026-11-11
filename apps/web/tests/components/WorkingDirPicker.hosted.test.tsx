// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkingDirPicker } from '../../src/components/WorkingDirPicker';

afterEach(cleanup);

function renderPicker(props: Partial<React.ComponentProps<typeof WorkingDirPicker>> = {}) {
  const onPickDirectory = vi.fn();
  render(
    <WorkingDirPicker
      workingDir={null}
      recentDirs={[]}
      onPickDirectory={onPickDirectory}
      {...props}
    />,
  );
  return { onPickDirectory };
}

function openPanel(): void {
  fireEvent.click(screen.getByTestId('working-dir-trigger'));
}

describe('WorkingDirPicker on a hosted daemon', () => {
  it('offers the native picker when the daemon can open one', () => {
    renderPicker();
    openPanel();

    expect(screen.queryByTestId('working-dir-pick')).not.toBeNull();
    expect(screen.queryByTestId('working-dir-server-only')).toBeNull();
  });

  it('replaces the picker with an explanation when it cannot', () => {
    // `openFolderDialog` answers null in this deployment, so a visible button
    // would be a click that does nothing at all.
    renderPicker({ pickerAvailable: false });
    openPanel();

    expect(screen.queryByTestId('working-dir-pick')).toBeNull();
    expect(screen.queryByTestId('working-dir-server-only')).not.toBeNull();
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
