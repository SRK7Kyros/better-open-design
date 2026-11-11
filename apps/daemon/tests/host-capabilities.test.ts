// The web build needs to know which affordances are meaningful before the user
// clicks them: a hosted daemon cannot open a native folder picker or read a
// path the user typed on someone else's machine.

import httpRequest from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

let server: Server | undefined;
let shutdown: (() => Promise<void> | void) | undefined;

afterEach(async () => {
  if (shutdown) await Promise.resolve(shutdown());
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  shutdown = undefined;
});

async function start(): Promise<string> {
  const started = (await startServer({ port: 0, host: '127.0.0.1', returnServer: true })) as {
    url: string;
    server: Server;
    shutdown?: () => Promise<void> | void;
  };
  server = started.server;
  shutdown = started.shutdown;
  return started.url;
}

function makeConnectionsAppearNonLoopback(target: Server): void {
  target.prependListener('connection', (socket) => {
    Object.defineProperty(socket, 'remoteAddress', {
      configurable: true,
      value: '172.18.0.1',
    });
  });
}

describe('GET /api/host-capabilities', () => {
  it('reports the local filesystem affordances to a loopback peer', async () => {
    const baseUrl = await start();
    const resp = await fetch(`${baseUrl}/api/host-capabilities`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      ok: true,
      sameMachine: true,
      folderPicker: true,
      localFolders: true,
      systemTerminal: true,
    });
  });

  it('reports a remote peer as unable to reach the local filesystem', async () => {
    process.env.OD_API_TOKEN = 'capabilities-test-token';
    try {
      const baseUrl = await start();
      makeConnectionsAppearNonLoopback(server!);
      const resp = await fetch(`${baseUrl}/api/host-capabilities`, {
        headers: { authorization: 'Bearer capabilities-test-token' },
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({
        ok: true,
        sameMachine: false,
        folderPicker: false,
        localFolders: false,
        systemTerminal: false,
      });
    } finally {
      delete process.env.OD_API_TOKEN;
    }
  });
});

describe('GET /api/editors on a remote daemon', () => {
  it('advertises no editor to a peer that cannot use one', async () => {
    process.env.OD_API_TOKEN = 'editors-test-token';
    try {
      const baseUrl = await start();
      // `connection: close` keeps undici from reusing a pooled socket opened
      // before the peer override, which would make the peer look loopback.
      const headers = { authorization: 'Bearer editors-test-token', connection: 'close' };

      const local = await fetch(`${baseUrl}/api/editors`, { headers });
      expect(local.status).toBe(200);
      const localBody = (await local.json()) as { editors: unknown[]; platform: string };
      expect(localBody.platform).not.toBe('unknown');

      makeConnectionsAppearNonLoopback(server!);
      const remote = await fetch(`${baseUrl}/api/editors`, { headers });
      expect(remote.status).toBe(200);
      expect(await remote.json()).toEqual({ editors: [], platform: 'unknown' });

      const openIn = await fetch(`${baseUrl}/api/projects/anything/open-in`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ editorId: 'file-manager' }),
      });
      expect(openIn.status).toBe(501);
      expect(await openIn.json()).toMatchObject({
        error: { code: 'HANDOFF_UNAVAILABLE' },
      });
    } finally {
      delete process.env.OD_API_TOKEN;
    }
  });
});

describe('POST /api/system/open-external on a remote daemon', () => {
  it('refuses to open a URL on the server and lets the client navigate itself', async () => {
    process.env.OD_API_TOKEN = 'open-external-test-token';
    try {
      const baseUrl = await start();
      makeConnectionsAppearNonLoopback(server!);
      const resp = await fetch(`${baseUrl}/api/system/open-external`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer open-external-test-token',
          'content-type': 'application/json',
          connection: 'close',
        },
        body: JSON.stringify({ url: 'https://example.com/upgrade' }),
      });
      expect(resp.status).toBe(501);
      expect(await resp.json()).toMatchObject({
        error: { code: 'OPEN_EXTERNAL_UNAVAILABLE' },
      });
    } finally {
      delete process.env.OD_API_TOKEN;
    }
  });
});

describe('requireLocalDaemonRequest behind a reverse proxy', () => {
  // nginx forwards `Host: $host`, so every route guarded by
  // `requireLocalDaemonRequest` (library, connectors, db maintenance) used to
  // answer 403 "request host must be a loopback daemon address" on the shape B
  // deployment this fork documents as recommended.
  function proxiedRequest(
    baseUrl: string,
    path: string,
    headers: Record<string, string>,
  ): Promise<{ status: number | undefined; body: string }> {
    const target = new URL(baseUrl);
    return new Promise((resolve, reject) => {
      const req = httpRequest.request(
        {
          hostname: target.hostname,
          port: target.port,
          path,
          method: 'GET',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('accepts the proxied host and origin declared in OD_ALLOWED_ORIGINS', async () => {
    process.env.OD_ALLOWED_ORIGINS = 'https://od.example.com';
    try {
      const baseUrl = await start();
      const allowed = await proxiedRequest(baseUrl, '/api/library/connection', {
        host: 'od.example.com',
        origin: 'https://od.example.com',
      });
      expect(allowed.status).toBe(200);

      // A rebound page sends its own hostname and origin; the origin middleware
      // rejects the pair first, and the host check is the second wall for a
      // request that carries no origin at all.
      const rebound = await proxiedRequest(baseUrl, '/api/library/connection', {
        host: 'attacker.example',
      });
      expect(rebound.status).toBe(403);
      expect(rebound.body).toContain('request host must be a loopback daemon address');

      const reboundWithOrigin = await proxiedRequest(baseUrl, '/api/library/connection', {
        host: 'attacker.example',
        origin: 'https://attacker.example',
      });
      expect(reboundWithOrigin.status).toBe(403);
    } finally {
      delete process.env.OD_ALLOWED_ORIGINS;
    }
  });
});
