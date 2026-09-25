'use client';

// Is the workspace still reachable from this page — or has the session in
// front of it ended? Behind Cloudflare Access (the self-host tunnel), an
// expired Access session turns every request, /health included, into a 302 to
// the Access login page; the app's own XHRs then just fail. This probes
// /health without following redirects so that case is recognisable, and the
// UI can say "sign in again" instead of silently going stale.
//
// Activity does not extend an Access session (its length is fixed at login by
// the Access application's session duration), so there is no keep-alive to do
// here — only detection.

import { useEffect, useState } from 'react';

export type Reachability = 'ok' | 'login' | 'offline' | 'unknown';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const PROBE_MS = 60_000;

/** Classify one probe result. Pure, for tests. */
export function classifyProbe(res: { type?: string; status: number; ok: boolean } | null): Reachability {
  if (!res) return 'offline';                             // network error, or the browser is offline
  if (res.type === 'opaqueredirect') return 'login';     // redirected to a login page
  if (res.status === 401 || res.status === 403) return 'login';
  if (res.ok) return 'ok';
  return 'offline';                                       // 5xx, 404 from a broken proxy, ...
}

async function probe(): Promise<Reachability> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  try {
    // Default (same-origin) credentials: on the tunnel origin the Access cookie
    // rides along; nothing is sent cross-origin.
    const res = await fetch(`${API_URL}/health`, { redirect: 'manual', cache: 'no-store' });
    return classifyProbe(res);
  } catch {
    return classifyProbe(null);
  }
}

/** Current reachability, re-checked every minute and whenever the tab regains focus or the network. */
export function useReachability(): Reachability {
  const [state, setState] = useState<Reachability>('unknown');
  useEffect(() => {
    let cancelled = false;
    const run = () => { void probe().then((s) => { if (!cancelled) setState(s); }); };
    run();
    const t = window.setInterval(run, PROBE_MS);
    const onFocus = () => { if (document.visibilityState === 'visible') run(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', run);
    window.addEventListener('offline', run);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', run);
      window.removeEventListener('offline', run);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);
  return state;
}

export const REACHABILITY_TITLE: Record<Reachability, string> = {
  ok: '',
  unknown: '',
  login: 'Signed out of the workspace (the sign-in in front of it expired) — click to sign in again',
  offline: 'Can’t reach the workspace right now — click to retry',
};
