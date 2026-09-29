/**
 * UI commands: a small, fixed set of things an MCP client may ask an open
 * workspace tab to do — the reverse direction of the presence heartbeat
 * (lib/active-thread.ts), which tells MCP clients what the tab is showing.
 *
 * Wire protocol (all ordinary workspace events, no backend change):
 *   MCP → UI   workspace.ui.command  target human:<user_id>
 *              payload {request_id, tab_id?, action, args, from?}
 *   UI  → MCP  workspace.ui.ack      target core
 *              payload {request_id, tab_id, ok, error?}
 * The tab polls for commands (use-ui-commands.ts); the MCP side picks a tab
 * from the heartbeat's tab_id and waits briefly for the ack.
 *
 * Deliberately read/navigate only: nothing here sends, deletes, archives or
 * changes settings, and there is no "open arbitrary URL" or script action. A
 * new action means changing this file, not just the MCP tool.
 */

export const UI_COMMAND_TYPE = 'workspace.ui.command';
export const UI_ACK_TYPE = 'workspace.ui.ack';

/** This-browser preference (settings → Preferences). Default on. */
export const UI_COMMANDS_KEY = 'oa_ui_commands';

/** Commands older than this when first seen are stale (a tab that just woke up). */
export const UI_COMMAND_MAX_AGE_MS = 30_000;
/** At most one executed command per this interval per tab. */
export const UI_COMMAND_MIN_INTERVAL_MS = 1_000;

export type UiCommand =
  | { action: 'open_thread'; channel: string }
  | { action: 'open_file'; fileId: string }
  | { action: 'notify'; text: string; link?: string; linkLabel?: string };

export type ParseResult = { ok: true; command: UiCommand } | { ok: false; error: string };

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;

/** Validate an incoming command payload against the allowlist. Pure. */
export function parseUiCommand(payload: unknown): ParseResult {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const args = (p.args && typeof p.args === 'object' ? p.args : {}) as Record<string, unknown>;
  switch (p.action) {
    case 'open_thread': {
      const channel = str(args.channel, 200);
      if (!channel) return { ok: false, error: 'open_thread needs args.channel' };
      return { ok: true, command: { action: 'open_thread', channel: channel.replace(/^channel\//, '') } };
    }
    case 'open_file': {
      const fileId = str(args.file_id, 200);
      if (!fileId) return { ok: false, error: 'open_file needs args.file_id' };
      return { ok: true, command: { action: 'open_file', fileId } };
    }
    case 'notify': {
      const text = str(args.text, 500);
      if (!text) return { ok: false, error: 'notify needs args.text (at most 500 characters)' };
      const link = args.link === undefined ? undefined : safeLink(args.link);
      if (args.link !== undefined && !link) return { ok: false, error: 'notify link must be an http(s) URL' };
      const linkLabel = str(args.link_label, 40) ?? undefined;
      return { ok: true, command: { action: 'notify', text, ...(link ? { link, linkLabel } : {}) } };
    }
    default:
      return { ok: false, error: `unknown action ${JSON.stringify(p.action)} (allowed: open_thread, open_file, notify)` };
  }
}

/** Only absolute http(s) URLs — never javascript:, data:, etc. Pure. */
export function safeLink(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Whether this tab should act on a command addressed to its user. Pure. */
export function isForThisTab(payload: unknown, tabId: string): boolean {
  const t = (payload as Record<string, unknown> | null)?.tab_id;
  return t === undefined || t === null || t === '' || t === tabId;
}

/** A short "who asked" label for the toast. Pure. */
export function commandSource(from: unknown, source: unknown): string {
  const f = typeof from === 'string' && from.trim() ? from.trim() : '';
  if (f) return f.slice(0, 40);
  const s = typeof source === 'string' ? source.replace(/^(openagents|human):/, '') : '';
  return s.slice(0, 40) || 'an agent';
}

/** Per-tab id, stable across reloads of the same tab, distinct between tabs. */
export function getTabId(): string {
  try {
    let id = sessionStorage.getItem('oa_tab_id');
    if (!id) {
      id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem('oa_tab_id', id);
    }
    return id;
  } catch {
    return 'tab-unknown';
  }
}

export function uiCommandsEnabled(): boolean {
  try { return localStorage.getItem(UI_COMMANDS_KEY) !== 'false'; } catch { return true; }
}
