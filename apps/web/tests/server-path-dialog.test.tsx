// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ServerPathDialogHost } from '../src/components/ServerPathDialogHost';
import { requestServerPath, setServerPathHandler } from '../src/runtime/server-path-request';

afterEach(() => {
  cleanup();
  setServerPathHandler(null);
});

describe('ServerPathDialogHost', () => {
  it('answers the caller with the path the user typed', async () => {
    render(<ServerPathDialogHost />);

    const answered = requestServerPath();

    const input = await screen.findByTestId('server-path-input');
    fireEvent.change(input, { target: { value: '/srv/projects/demo' } });
    fireEvent.click(screen.getByTestId('server-path-submit'));

    await expect(answered).resolves.toBe('/srv/projects/demo');
    await waitFor(() => expect(screen.queryByTestId('server-path-dialog')).toBeNull());
  });

  it('answers null when the dialog is dismissed, so callers keep their cancel path', async () => {
    render(<ServerPathDialogHost />);

    const answered = requestServerPath();
    await screen.findByTestId('server-path-input');

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await expect(answered).resolves.toBeNull();
    await waitFor(() => expect(screen.queryByTestId('server-path-dialog')).toBeNull());
  });

  it('refuses a relative path instead of handing the daemon its own cwd', async () => {
    render(<ServerPathDialogHost />);

    let settled = false;
    const answered = requestServerPath().then((value) => {
      settled = true;
      return value;
    });

    const input = await screen.findByTestId('server-path-input');
    fireEvent.change(input, { target: { value: 'projects/demo' } });
    fireEvent.click(screen.getByTestId('server-path-submit'));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    expect(screen.getByRole('alert').textContent).toMatch(/absolute path/i);
    expect(settled).toBe(false);
    expect(screen.queryByTestId('server-path-dialog')).not.toBeNull();

    // The field is still usable: clearing the error lets the user correct it.
    fireEvent.change(input, { target: { value: '/srv/projects/demo' } });
    fireEvent.click(screen.getByTestId('server-path-submit'));
    await expect(answered).resolves.toBe('/srv/projects/demo');
  });

  it('answers a second concurrent request immediately instead of stacking modals', async () => {
    render(<ServerPathDialogHost />);

    const first = requestServerPath();
    const second = requestServerPath();

    await expect(second).resolves.toBeNull();

    const input = await screen.findByTestId('server-path-input');
    fireEvent.change(input, { target: { value: '/srv/a' } });
    fireEvent.click(screen.getByTestId('server-path-submit'));
    await expect(first).resolves.toBe('/srv/a');
  });

  it('carries the caller hint into the dialog so the reason sits next to the field', async () => {
    render(<ServerPathDialogHost />);

    const answered = requestServerPath({ hint: 'This daemon runs on another machine.' });

    await screen.findByTestId('server-path-input');
    expect(screen.getByText('This daemon runs on another machine.')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await expect(answered).resolves.toBeNull();
  });
});
