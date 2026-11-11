/**
 * Client half of the daemon session (`apps/daemon/src/routes/daemon-session.ts`).
 *
 * The daemon can require `OD_API_TOKEN` for `/api`. A browser cannot send a
 * bearer token, so it exchanges one for an HttpOnly cookie once and every
 * transport — `fetch`, `EventSource`, `<img>`, `<iframe>` — carries it from
 * then on. This module owns the exchange; `api-origin.ts` owns making the
 * requests same-site in the first place.
 */

export interface DaemonSessionState {
  required: boolean;
  authenticated: boolean;
}

export type UnlockResult = { ok: true } | { ok: false; message: string };
/**
 * Broadcast when a daemon request comes back 401: the cookie expired, or the
 * operator rotated `OD_API_TOKEN`. The shell listens for it and offers the
 * unlock form again *over* the running app — without this, the first expiry
 * leaves every panel failing with no way back except a manual reload.
 */
export const DAEMON_UNAUTHORIZED_EVENT = 'od-daemon-unauthorized';

export function reportDaemonUnauthorized(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(DAEMON_UNAUTHORIZED_EVENT));
}


const SESSION_PATH = '/api/auth/session';

function sessionUrl(): string {
  // Already rewritten by the fetch interceptor when a base is configured, so a
  // relative path is correct here — and it keeps this module usable in tests
  // that stub `fetch`.
  return SESSION_PATH;
}

export async function probeDaemonSession(): Promise<DaemonSessionState | null> {
  try {
    const response = await fetch(sessionUrl(), {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<DaemonSessionState>;
    return {
      required: body.required === true,
      authenticated: body.authenticated === true,
    };
  } catch {
    return null;
  }
}

export async function unlockDaemon(token: string): Promise<UnlockResult> {
  let response: Response;
  try {
    response = await fetch(sessionUrl(), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    return { ok: false, message: 'Could not reach the daemon.' };
  }

  if (response.ok) return { ok: true };

  let message = `Unlock failed (${response.status}).`;
  try {
    const body = (await response.json()) as { error?: { message?: unknown } | string };
    if (typeof body.error === 'string') message = body.error;
    else if (typeof body.error?.message === 'string') message = body.error.message;
  } catch {
    /* keep the status-based message */
  }
  return { ok: false, message };
}
