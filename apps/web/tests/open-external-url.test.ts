// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openExternalUrl } from '../src/providers/registry';

/**
 * A hosted daemon answers 501 OPEN_EXTERNAL_UNAVAILABLE: the URL has to open in
 * *this* browser. Navigating the current tab instead throws the running app
 * away mid-task, which is what a sign-in or docs link must never do.
 *
 * jsdom's `location.assign` is [LegacyUnforgeable], so it cannot be spied on.
 * The observable contract is therefore: a tab is opened and the call reports
 * success, or (popup blocked) it reports failure and the href is untouched.
 */
function stubOpenExternal(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubWindow(result: 'tab' | 'blocked') {
  const opened = { opener: {} as unknown };
  const open = vi.spyOn(window, 'open').mockImplementation(
    () => (result === 'tab' ? (opened as unknown as Window) : null),
  );
  return { open, opened };
}

const hrefBefore = () => window.location.href;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('openExternalUrl', () => {
  it('opens a new tab when the daemon cannot launch a browser', async () => {
    stubOpenExternal(501, { error: 'open external is unavailable here', code: 'OPEN_EXTERNAL_UNAVAILABLE' });
    const { open, opened } = stubWindow('tab');
    const href = hrefBefore();

    await expect(openExternalUrl('https://example.com/docs')).resolves.toBe(true);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank');
    // The tab must not keep a handle back to the app.
    expect(opened.opener).toBeNull();
    expect(window.location.href).toBe(href);
  });

  it('opens a new tab when the request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    const { open } = stubWindow('tab');

    await expect(openExternalUrl('https://example.com/docs')).resolves.toBe(true);

    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank');
  });

  it('leaves the tab alone when the daemon did open it', async () => {
    stubOpenExternal(200, { ok: true });
    const { open } = stubWindow('tab');

    await expect(openExternalUrl('https://example.com/docs')).resolves.toBe(true);

    expect(open).not.toHaveBeenCalled();
  });

  it('reports failure when the popup is blocked rather than claiming success', async () => {
    stubOpenExternal(501, { error: 'unavailable', code: 'OPEN_EXTERNAL_UNAVAILABLE' });
    stubWindow('blocked');

    await expect(openExternalUrl('https://example.com/docs')).resolves.toBe(false);
  });
});
