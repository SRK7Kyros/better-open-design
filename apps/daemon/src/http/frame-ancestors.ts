import { configuredAllowedOrigins } from '../origin-validation.js';

/**
 * `frame-ancestors` value for the documents the daemon hands to a browser to
 * embed: live-artifact previews and plugin preview assets.
 *
 * `'self'` alone is correct only when the web build and the daemon share an
 * origin (upstream's single process, or a reverse proxy that fronts both). In
 * the split-origin deployment this fork adds, the page lives on
 * `https://od.example.com` and the preview document on
 * `https://od-api.example.com`, so the browser refuses to paint the frame —
 * the console reports "Refused to frame … because an ancestor violates the
 * following Content Security Policy directive: frame-ancestors 'self'" and the
 * preview panel is an empty canvas.
 *
 * The operator already declares the browser origins that may talk to the
 * daemon in `OD_ALLOWED_ORIGINS` (it drives both the origin guard and the CORS
 * responder), so the same list is the right answer here: a page that is not
 * allowed to call the API has no business framing its documents either.
 *
 * `'self'` is always kept, which also covers deployments that never set the
 * variable.
 */
export function frameAncestorsDirective(env: NodeJS.ProcessEnv = process.env): string {
  let origins: string[] = [];
  try {
    origins = configuredAllowedOrigins(env);
  } catch {
    // A malformed entry is rejected at boot by `server.ts`, so this is only
    // reachable from a caller that parsed a different env. Fall back to the
    // strict value rather than letting one typo widen the policy.
    origins = [];
  }
  const unique = Array.from(new Set(origins));
  return ["'self'", ...unique].join(' ');
}
