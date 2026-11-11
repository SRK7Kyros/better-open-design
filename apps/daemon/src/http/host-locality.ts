/**
 * Whether the browser that sent this request runs on the daemon's own machine.
 *
 * Only then do the OS-facing surfaces mean anything: a native folder picker, the
 * editor catalogue (`xdg-open cursor` spawns on the daemon), a system terminal,
 * and paths typed by the user. A loopback peer is the signal, with one hole an
 * operator has to close: a *local* reverse proxy makes the peer loopback while
 * the browser is remote, which is what `OD_HOSTED=1` declares.
 */

import type { IncomingMessage } from 'node:http';

import { isLoopbackPeerAddress } from './local-daemon-request.js';

const HOSTED_VALUES = /^(1|true|yes|on)$/i;

export function isHostedDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return HOSTED_VALUES.test(String(env.OD_HOSTED ?? '').trim());
}

export function isSameMachineRequest(
  req: Pick<IncomingMessage, 'socket'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isHostedDeployment(env)) return false;
  return isLoopbackPeerAddress(req.socket?.remoteAddress);
}
