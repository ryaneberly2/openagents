'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { workspaceApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import {
  UI_ACK_TYPE, UI_COMMAND_MAX_AGE_MS, UI_COMMAND_MIN_INTERVAL_MS, UI_COMMAND_TYPE,
  commandSource, getTabId, isForThisTab, parseUiCommand, uiCommandsEnabled,
} from '@/lib/ui-commands';
import { useLayout } from './layout-context';

const POLL_MS = 1_500;

/**
 * Carries out UI commands (lib/ui-commands.ts) addressed to this user and tab.
 * Mounted once, in Wrapper — the one place with both the workspace and the
 * layout context, like the presence heartbeat's reportViewMode.
 *
 * Polls /v1/events for workspace.ui.command targeted at human:<me>, starting
 * at the current head so nothing already posted is replayed. Every command
 * gets an ack, including refusals, so the MCP tool can say what happened.
 */
export function useUiCommands() {
  const { currentUser, sessions, files, setCurrentSessionId, setSelectedFileId } = useWorkspace();
  const { setViewMode, isMobile, openMobileDetail } = useLayout();

  // The poll loop is set up once per user; it reads everything else through
  // this ref so it always acts on the current render's state.
  const live = useRef({ sessions, files, setCurrentSessionId, setSelectedFileId, setViewMode, isMobile, openMobileDetail });
  live.current = { sessions, files, setCurrentSessionId, setSelectedFileId, setViewMode, isMobile, openMobileDetail };

  useEffect(() => {
    const userId = currentUser.id;
    if (!userId) return;
    const tabId = getTabId();
    const target = `human:${userId}`;
    let cursor: string | null = null;
    let lastRun = 0;
    let cancelled = false;
    let timer: number | undefined;

    const ack = (requestId: unknown, ok: boolean, error?: string) => {
      if (typeof requestId !== 'string' || !requestId) return;
      void workspaceApi.sendEvent({
        type: UI_ACK_TYPE,
        source: target,
        target: 'core',
        payload: { request_id: requestId, tab_id: tabId, ok, ...(error ? { error } : {}) },
        visibility: 'network',
      }).catch(() => {});
    };

    const run = (payload: Record<string, unknown>, source: string): string | null => {
      const parsed = parseUiCommand(payload);
      if (!parsed.ok) return parsed.error;
      const who = commandSource(payload.from, source);
      const s = live.current;
      const cmd = parsed.command;
      if (cmd.action === 'open_thread') {
        const session = s.sessions.find((x) => x.sessionId === cmd.channel);
        if (!session) return `thread ${cmd.channel} is not in this tab's thread list (archived, or not loaded)`;
        s.setCurrentSessionId(cmd.channel);
        s.setViewMode('threads');
        if (s.isMobile) s.openMobileDetail();
        toast(`Opened by ${who}`, { description: session.title || cmd.channel, duration: 4000 });
        return null;
      }
      if (cmd.action === 'open_file') {
        const file = s.files.find((f) => f.id === cmd.fileId);
        if (!file) return `file ${cmd.fileId} is not in this workspace's file list`;
        s.setSelectedFileId(cmd.fileId);
        s.setViewMode('files');
        if (s.isMobile) s.openMobileDetail();
        toast(`Opened by ${who}`, { description: file.filename, duration: 4000 });
        return null;
      }
      // notify — a link only ever opens from the user's own click on the button.
      const link = cmd.link;
      toast(cmd.text, {
        description: `from ${who}`,
        duration: link ? 15000 : 8000,
        ...(link ? { action: { label: cmd.linkLabel || 'Open', onClick: () => window.open(link, '_blank', 'noopener,noreferrer') } } : {}),
      });
      return null;
    };

    const handle = (ev: { id: string; source: string; timestamp?: number; payload?: Record<string, unknown> }) => {
      const payload = ev.payload || {};
      if (!isForThisTab(payload, tabId)) return;               // another tab's command: not ours to ack
      const requestId = payload.request_id;
      if (ev.timestamp && Date.now() - ev.timestamp > UI_COMMAND_MAX_AGE_MS) return ack(requestId, false, 'command expired before this tab saw it');
      if (!uiCommandsEnabled()) return ack(requestId, false, 'agent control is turned off in this tab (Settings → Preferences)');
      const now = Date.now();
      if (now - lastRun < UI_COMMAND_MIN_INTERVAL_MS) return ack(requestId, false, 'rate limited: at most one command per second');
      lastRun = now;
      let error: string | null;
      try { error = run(payload, ev.source); } catch (e) { error = e instanceof Error ? e.message : 'failed'; }
      ack(requestId, !error, error || undefined);
    };

    const poll = async () => {
      try {
        if (cursor === null) {
          // Anchor at the head: commands posted before this tab opened are not replayed.
          const head = await workspaceApi.pollEvents({ type: UI_COMMAND_TYPE, target, sort: 'desc', limit: 1 });
          cursor = head.events[0]?.id ?? '';
        } else {
          const res = await workspaceApi.pollEvents({ type: UI_COMMAND_TYPE, target, sort: 'asc', limit: 20, ...(cursor ? { after: cursor } : {}) });
          if (cancelled) return;
          for (const ev of res.events) {
            cursor = ev.id;
            handle(ev as unknown as Parameters<typeof handle>[0]);
          }
        }
      } catch {
        // non-critical — try again next tick
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
    };
    void poll();

    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [currentUser.id]);
}
