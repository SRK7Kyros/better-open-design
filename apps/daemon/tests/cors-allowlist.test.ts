import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAllowedOriginCors } from '../src/http/cors-allowlist.js';
import { isAllowedBrowserOrigin } from '../src/origin-validation.js';

const ALLOWED = 'https://od.example.com';

function makeTestApp() {
  const app = express();
  const cors = createAllowedOriginCors([ALLOWED]);
  app.use('/api', cors);
  app.get('/api/info', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

/**
 * The production order from `server.ts`: the CORS responder answers preflight,
 * then the origin guard decides whether the request may proceed at all.
 */
function makeGuardedApp() {
  const app = express();
  const cors = createAllowedOriginCors([ALLOWED]);
  app.use('/api', cors);
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin == null || origin === '') return next();
    if (!isAllowedBrowserOrigin(origin, req.headers.host, [], '127.0.0.1', [ALLOWED])) {
      res.status(403).json({ error: 'Cross-origin requests are not allowed' });
      return;
    }
    next();
  });
  app.get('/api/info', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('createAllowedOriginCors', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = makeTestApp().listen(0, '127.0.0.1', () => {
          baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          resolve();
        });
      }),
  );

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function request(path: string, options: { method?: string; headers?: Record<string, string> } = {}) {
    return fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: options.headers,
      redirect: 'manual',
    });
  }

  it('answers preflight for an allowlisted origin', async () => {
    const response = await request('/api/info', {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('stamps the response headers on a real request', async () => {
    const response = await request('/api/info', { headers: { Origin: ALLOWED } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    await response.arrayBuffer();
  });

  it('never echoes an origin that is not on the allowlist', async () => {
    const response = await request('/api/info', { headers: { Origin: 'https://evil.example' } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    await response.arrayBuffer();
  });

  it('leaves same-origin and non-browser requests untouched', async () => {
    const noOrigin = await request('/api/info');
    expect(noOrigin.status).toBe(200);
    expect(noOrigin.headers.get('access-control-allow-origin')).toBeNull();
    await noOrigin.arrayBuffer();

    const nullOrigin = await request('/api/info', { headers: { Origin: 'null' } });
    expect(nullOrigin.headers.get('access-control-allow-origin')).toBeNull();
    await nullOrigin.arrayBuffer();
  });
});

describe('CORS responder composed with the origin guard', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = makeGuardedApp().listen(0, '127.0.0.1', () => {
          baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          resolve();
        });
      }),
  );

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('lets the allowlisted web origin through with readable headers', async () => {
    const response = await fetch(`${baseUrl}/api/info`, { headers: { Origin: ALLOWED } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('blocks an unlisted origin before the route, without CORS headers', async () => {
    const response = await fetch(`${baseUrl}/api/info`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    await response.arrayBuffer();
  });
});
