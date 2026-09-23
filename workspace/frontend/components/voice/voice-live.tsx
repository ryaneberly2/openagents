'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Mic, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// The voice console is a separate app served by the same nginx front door at
// /voice/ (see openagents/voice/setup-voice-wsl.sh), so it shares this page's
// origin: its localStorage handoff with workspace-context.tsx (active thread in,
// focus-thread toast out) works from inside the iframe or a pop-out window alike.
const VOICE_URL = '/voice/';
const POPOUT_NAME = 'openagents-voice';
const POPOUT_FEATURES = 'popup=yes,width=520,height=760';

interface VoiceLiveProps {
  /** Rail is expanded: show a labelled pill instead of an icon-only button. */
  showLabels: boolean;
}

/**
 * "Live" entry point for the voice console: a button for the nav rail header and
 * a floating docked pane hosting the full console, with an optional pop-out.
 *
 * Closing the pane unmounts the iframe on purpose — that ends the voice session
 * and releases the mic, rather than leaving a hot microphone running invisibly.
 */
export function VoiceLive({ showLabels }: VoiceLiveProps) {
  const [open, setOpen] = React.useState(false);
  const popupRef = React.useRef<Window | null>(null);

  const popupIsOpen = () => !!popupRef.current && !popupRef.current.closed;

  const toggle = () => {
    // A second console would open a second Gemini Live session on the same
    // mic, so an existing pop-out wins over docking a new pane.
    if (popupIsOpen()) {
      popupRef.current?.focus();
      return;
    }
    setOpen((v) => !v);
  };

  const popOut = () => {
    const win = window.open(VOICE_URL, POPOUT_NAME, POPOUT_FEATURES);
    if (!win) return; // blocked by the browser; keep the docked pane
    popupRef.current = win;
    setOpen(false);
  };

  const button = showLabels ? (
    <Button variant="outline" size="sm" onClick={toggle} aria-pressed={open} className="shrink-0 gap-1.5">
      <Mic className={cn('size-3.5', open && 'text-emerald-500')} />
      Live
    </Button>
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" mode="icon" size="sm" onClick={toggle} aria-pressed={open} aria-label="Live voice">
          <Mic className={cn('size-4', open && 'text-emerald-500')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">Live voice</TooltipContent>
    </Tooltip>
  );

  const pane = open
    ? createPortal(
        <div
          role="dialog"
          aria-label="Live voice"
          className="fixed right-4 bottom-4 z-50 flex h-[min(680px,80vh)] w-[min(460px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        >
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
            <span className="flex items-center gap-1.5 text-xs font-semibold">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
              Live voice
            </span>
            <div className="flex items-center gap-0.5">
              <Button variant="ghost" mode="icon" size="sm" onClick={popOut} aria-label="Pop out" title="Pop out">
                <ExternalLink className="size-3.5" />
              </Button>
              <Button variant="ghost" mode="icon" size="sm" onClick={() => setOpen(false)} aria-label="Close" title="Close (ends the voice session)">
                <X className="size-3.5" />
              </Button>
            </div>
          </div>
          <iframe
            src={VOICE_URL}
            title="Voice console"
            allow="microphone; autoplay"
            className="min-h-0 w-full flex-1 border-0 bg-slate-950"
          />
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      {button}
      {pane}
    </>
  );
}
