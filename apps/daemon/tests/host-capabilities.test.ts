// The web build needs to know which affordances are meaningful before the user
// clicks them: a hosted daemon cannot open a native folder picker or read a
// path the user typed on someone else's machine.

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
