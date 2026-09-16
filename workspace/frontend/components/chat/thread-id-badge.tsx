'use client';

// SELF-HOST: the UI never shows a thread's channel name — the id that agents,
// workspace-mcp and the REST API all take as `channel`. Mounted after the
// thread title in the desktop app header (components/layout/app-header.tsx)
// and the mobile pane header (components/chat/chat-view.tsx). Click copies
// the id to the clipboard. Self-contained: reads the current thread from
// workspace context when no prop is given.

import { Check, Copy } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { useWorkspace } from '@/lib/workspace-context';

export function ThreadIdBadge({ channelName }: { channelName?: string } = {}) {
  const { currentSessionId } = useWorkspace();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const id = channelName ?? currentSessionId ?? '';
  if (!id || id.startsWith('dm:')) return null;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); copyToClipboard(id); }}
      title="Thread / channel id — click to copy"
      className="flex items-center gap-1 shrink-0 text-[11px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-mono transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-700"
    >
      {isCopied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
      <span>{isCopied ? 'copied' : id}</span>
    </button>
  );
}
