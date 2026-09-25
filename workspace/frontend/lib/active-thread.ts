// What a human is looking at, published in their presence heartbeat
// (workspace.user.* events, see workspace-context.tsx) so MCP clients can ask
// "what is the user looking at?" — the self-host workspace-mcp bridge exposes
// it as workspace_get_active_view / workspace_get_active_thread. The open
// thread also goes to the voice console through localStorage
// (openagents:active-thread).

export interface ActiveThread {
  channel: string;
  title: string | null;
}

/** The presence-payload value for the currently selected thread, or null when none is selected. */
export function activeThreadPayload(
  sessionId: string | null,
  sessions: ReadonlyArray<{ sessionId: string; title?: string | null }>,
): ActiveThread | null {
  if (!sessionId) return null;
  const title = sessions.find((s) => s.sessionId === sessionId)?.title || null;
  return { channel: sessionId, title };
}

export interface ActiveView {
  /** The main view: threads, files, browser, routines, knowledge, tasks, ... (null before the layout reports one). */
  mode: string | null;
  /** threads / routines: the open thread or routine channel. */
  thread?: ActiveThread | null;
  /** files: the file open in the preview (null when only a folder is showing), and the folder path. */
  file?: { id: string; filename: string | null } | null;
  folder?: string | null;
  /** browser: the selected shared-browser tab. */
  browser_tab?: { id: string; title: string | null; url: string | null } | null;
}

export interface ActiveViewInput {
  mode: string | null;
  sessionId: string | null;
  sessions: ReadonlyArray<{ sessionId: string; title?: string | null }>;
  selectedFileId: string | null;
  files: ReadonlyArray<{ id: string; filename: string }>;
  currentFilePath: string;
  selectedBrowserTabId: string | null;
  browserTabs: ReadonlyArray<{ id: string; title: string | null; url: string }>;
}

/** The presence-payload value for the whole current view. Only the fields that belong to the mode are set. */
export function activeViewPayload(v: ActiveViewInput): ActiveView {
  switch (v.mode) {
    case 'threads':
    case 'routines':
      return { mode: v.mode, thread: activeThreadPayload(v.sessionId, v.sessions) };
    case 'files': {
      const f = v.selectedFileId ? v.files.find((x) => x.id === v.selectedFileId) : null;
      return {
        mode: 'files',
        file: v.selectedFileId ? { id: v.selectedFileId, filename: f ? f.filename : null } : null,
        folder: v.currentFilePath || null,
      };
    }
    case 'browser': {
      const t = v.selectedBrowserTabId ? v.browserTabs.find((x) => x.id === v.selectedBrowserTabId) : null;
      return {
        mode: 'browser',
        browser_tab: v.selectedBrowserTabId ? { id: v.selectedBrowserTabId, title: t ? t.title : null, url: t ? t.url : null } : null,
      };
    }
    default:
      return { mode: v.mode };
  }
}
