'use client';

// Pills in the desktop app header for the environments HELD BY THE CURRENT
// THREAD, plus a small key on each thread row that holds one (EnvRowKey).
// An environment is held by a thread when the environment host's ops-server
// reports that thread id for it. Data comes from that ops-server through a
// same-origin proxied path (NEXT_PUBLIC_ELROND_OPS_PATH), so the page can read
// /ops/status and POST /ops/release-thread/<name> without mixed-content or
// cross-site refusals.
//   left click   -> open the environment page (NEXT_PUBLIC_ELROND_EXTERNAL_BASE + its path)
//   right click  -> menu: open env, jump to the environment index, release from this thread
// Renders nothing when the feature is not configured, the ops-server is
// unreachable, or the thread holds no environment.

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Key, LayoutGrid, Loader2, Unlink } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWorkspace } from '@/lib/workspace-context';

// Build-time settings (Dockerfile ARGs); both empty = feature off. The
// external base is configured rather than taken from /ops/status's humanBase,
// which may be host-local and useless to a browser on another machine.
const OPS = process.env.NEXT_PUBLIC_ELROND_OPS_PATH || '';
const EXTERNAL_BASE = process.env.NEXT_PUBLIC_ELROND_EXTERNAL_BASE || '';
const POLL_MS = 30_000;

type EnvThread = { id: string; title?: string | null };
type Env = {
  name: string;
  path: string;
  state: string;
  podStatus?: string | null;
  thread: EnvThread | null;
  purpose?: { text?: string | null } | null;
};
type OpsStatus = { envs?: Env[] };

let cache: { at: number; data: OpsStatus | null } = { at: 0, data: null };
async function loadStatus(force: boolean): Promise<OpsStatus | null> {
  if (!OPS) return null;
  if (!force && Date.now() - cache.at < 5000) return cache.data;
  try {
    const r = await fetch(`${OPS}/ops/status`, { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    cache = { at: Date.now(), data: (await r.json()) as OpsStatus };
  } catch {
    cache = { at: Date.now(), data: null };
  }
  return cache.data;
}

// One poller for every consumer (the header pills and a key badge per thread
// row) — a timer per row would hit /ops/status once per thread.
const listeners = new Set<(s: OpsStatus | null) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
async function refreshAll(force: boolean) {
  const s = await loadStatus(force);
  listeners.forEach((l) => l(s));
}
function useOpsStatus(): [OpsStatus | null, () => void] {
  const [status, setStatus] = useState<OpsStatus | null>(cache.data);
  useEffect(() => {
    listeners.add(setStatus);
    void loadStatus(false).then(setStatus);
    if (OPS && !pollTimer) pollTimer = setInterval(() => void refreshAll(true), POLL_MS);
    return () => {
      listeners.delete(setStatus);
      if (listeners.size === 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    };
  }, []);
  const refresh = useCallback(() => void refreshAll(true), []);
  return [status, refresh];
}

/**
 * A small key on a thread row's avatar when that thread holds one or
 * more elrond environments — the same "held by" test as the header pills.
 * Mounted in thread-list.tsx's ThreadRow.
 */
export function EnvRowKey({ sessionId }: { sessionId: string }) {
  const [status] = useOpsStatus();
  if (!sessionId || sessionId.startsWith('dm:') || !status?.envs) return null;
  const held = status.envs.filter((e) => e.thread?.id === sessionId);
  if (held.length === 0) return null;
  const tip = `Holds ${held.map((e) => `${e.name} (${e.state})`).join(', ')}`;
  return (
    <span
      title={tip}
      aria-label={tip}
      className="absolute -bottom-1 -left-1 flex size-4 items-center justify-center rounded-full bg-amber-100 text-amber-800 ring-2 ring-background dark:bg-amber-900 dark:text-amber-200"
    >
      <Key className="size-2.5" />
    </span>
  );
}

export function EnvPills() {
  const { currentSessionId } = useWorkspace();
  const [status, refresh] = useOpsStatus();

  if (!currentSessionId || currentSessionId.startsWith('dm:') || !status?.envs) return null;
  const held = status.envs.filter((e) => e.thread?.id === currentSessionId);
  if (held.length === 0) return null;
  const base = EXTERNAL_BASE;
  return (
    <>
      {held.map((e) => (
        <EnvPill key={e.name} env={e} base={base} onChanged={refresh} />
      ))}
    </>
  );
}

function EnvPill({ env, base, onChanged }: { env: Env; base: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const envUrl = `${base}${env.path}`;
  const indexUrl = `${base}/`;
  const running = env.state === 'running';
  const openTab = (url: string) => window.open(url, '_blank', 'noopener');

  const release = async () => {
    if (!window.confirm(`Release ${env.name} from this thread?\nAny thread may then claim it with env.sh thread.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`${OPS}/ops/release-thread/${encodeURIComponent(env.name)}`, { method: 'POST' });
      if (!r.ok) window.alert(`release ${env.name} failed (HTTP ${r.status})`);
    } catch (err) {
      window.alert(`release ${env.name} failed: ${String(err)}`);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const tip = [
    `${env.name} — ${env.state}${env.podStatus ? ` (${env.podStatus})` : ''}`,
    env.purpose?.text || '',
    'click: open · right-click: menu',
  ].filter(Boolean).join('\n');

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={tip}
          onPointerDown={(e) => { if (e.button === 0) e.preventDefault(); }}
          onClick={() => openTab(envUrl)}
          onContextMenu={(e) => { e.preventDefault(); setOpen(true); }}
          className="flex items-center gap-1 shrink-0 text-[11px] px-1.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 font-mono transition-colors hover:bg-amber-100 dark:hover:bg-amber-900/50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Key className="size-3" />}
          <span>{env.name}</span>
          <span className={`size-1.5 rounded-full ${running ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="text-xs">
        <DropdownMenuLabel className="font-mono text-[11px]">{env.name} · {env.state}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openTab(envUrl)}>
          <ExternalLink className="size-3.5" /> Open {env.name}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openTab(indexUrl)}>
          <LayoutGrid className="size-3.5" /> Jump to elrond page
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onSelect={() => void release()} className="text-red-600 dark:text-red-400">
          <Unlink className="size-3.5" /> Release from this thread
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
