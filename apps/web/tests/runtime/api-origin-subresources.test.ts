// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  installApiOriginRewriter,
  installDaemonSubresourceRewriter,
} from '../../src/runtime/api-origin';

const BASE = 'https://od.example.com';

const install = (apiBase = BASE) => {
  installDaemonSubresourceRewriter(window as unknown as Window & typeof globalThis, apiBase);
};

const element = (tag: string): HTMLElement => {
  const node = document.createElement(tag);
  document.body.appendChild(node);
  return node;
};

const NATIVE_SET_ATTRIBUTE = Element.prototype.setAttribute;

afterEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(Element.prototype, 'setAttribute', {
    configurable: true,
    writable: true,
    value: NATIVE_SET_ATTRIBUTE,
  });
  delete (Element.prototype as unknown as Record<string, unknown>).__odSubresourceRewriterInstalled;
});

describe('daemon subresource rewriter', () => {
  it('points daemon-owned subresources at the daemon origin', () => {
    install();

    const image = element('img');
    image.setAttribute('src', '/api/projects/p1/preview/hero.png');
    expect(image.getAttribute('src')).toBe(`${BASE}/api/projects/p1/preview/hero.png`);

    const poster = element('video');
    poster.setAttribute('poster', '/artifacts/abc/frame.jpg');
    expect(poster.getAttribute('poster')).toBe(`${BASE}/artifacts/abc/frame.jpg`);

    const frame = element('iframe');
    frame.setAttribute('src', '/api/projects/p1/preview/');
    expect(frame.getAttribute('src')).toBe(`${BASE}/api/projects/p1/preview/`);

    const download = element('a');
    download.setAttribute('href', '/frames/deck.pdf');
    expect(download.getAttribute('href')).toBe(`${BASE}/frames/deck.pdf`);

    const plugin = element('script');
    plugin.setAttribute('src', '/plugins/demo/preview.js');
    expect(plugin.getAttribute('src')).toBe(`${BASE}/plugins/demo/preview.js`);
  });

  it('leaves non-daemon and non-URL values untouched', () => {
    install();

    const image = element('img');
    image.setAttribute('src', 'https://cdn.example.com/hero.png');
    expect(image.getAttribute('src')).toBe('https://cdn.example.com/hero.png');

    image.setAttribute('src', 'data:image/png;base64,AAAA');
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AAAA');

    image.setAttribute('src', '/agent-icons/qoder.svg');
    expect(image.getAttribute('src')).toBe('/agent-icons/qoder.svg');

    const link = element('a');
    link.setAttribute('href', '/projects/abc');
    expect(link.getAttribute('href')).toBe('/projects/abc');

    image.setAttribute('alt', '/api/not-a-url');
    expect(image.getAttribute('alt')).toBe('/api/not-a-url');
  });

  it('is idempotent, so re-setting a rewritten value cannot loop', () => {
    install();
    const image = element('img');

    image.setAttribute('src', '/api/info');
    const once = image.getAttribute('src');
    image.setAttribute('src', String(once));
    expect(image.getAttribute('src')).toBe(once);
    expect(once).toBe(`${BASE}/api/info`);
  });

  it('does not stack wrappers when installed twice', () => {
    install();
    install();
    const image = element('img');
    image.setAttribute('src', '/api/info');
    expect(image.getAttribute('src')).toBe(`${BASE}/api/info`);
  });

  it('is a no-op without a daemon base', () => {
    install('');
    const image = element('img');
    image.setAttribute('src', '/api/projects/p1/preview/hero.png');
    expect(image.getAttribute('src')).toBe('/api/projects/p1/preview/hero.png');
  });

  it('is installed by the transport rewriter only when a base resolves', () => {
    const win = window as unknown as Window & typeof globalThis & {
      __OD_CONFIG__?: { apiBase: string };
      document: Document;
    };
    win.__OD_CONFIG__ = { apiBase: 'https://second.example.com' };
    expect(installApiOriginRewriter(win)).toBe('https://second.example.com');

    const image = element('img');
    image.setAttribute('src', '/api/info');
    expect(image.getAttribute('src')).toBe('https://second.example.com/api/info');
  });
});
