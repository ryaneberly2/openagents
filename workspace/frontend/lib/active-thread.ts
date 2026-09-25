// The thread a human has open, published in their presence heartbeat
// (workspace.user.* events, see workspace-context.tsx) so MCP clients can ask
// "what is the user looking at?" — the self-host workspace-mcp bridge exposes
// it as workspace_get_active_thread. The same value also goes to the voice
// console through localStorage (openagents:active-thread).

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
