'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { AppWindow, ExternalLink, Mic, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// The voice console is a separate app served by the same nginx front door at
// /voice/ (see openagents/voice/setup-voice-wsl.sh), so it shares this page's
// origin: postMessage is checked against it, and the console's localStorage
// handoff with workspace-context.tsx (open thread in, focus-thread toast out)
// works from the iframe or the pop-out window alike.
const VOICE_URL = '/voice/';
const POPOUT_NAME = 'openagents-voice';
const POPOUT_FEATURES = 'popup=yes,width=520,height=760';

interface VoiceLiveProps {
  /** Rail is expanded: show a labelled pill instead of an icon-only button. */
  showLabels: boolean;
}

/**
 * Two separate controls for the voice console:
 *
 *  - Live: starts/stops the voice session itself. The console runs in an iframe
 *    that stays mounted but parked off-screen, so going live shows nothing.
 *  - Pane: shows that same iframe as a floating pane with the full interface,
 *    which can itself be moved to a real window. The session survives showing
 *    and hiding the pane; only Live (or the window closing) ends it.
 */
export function VoiceLive({ showLabels }: VoiceLiveProps) {
  const [mounted, setMounted] = React.useState(false);
  const [paneOpen, setPaneOpen] = React.useState(false);
  const [live, setLive] = React.useState(false);
  const [speaking, setSpeaking] = React.useState(false);

  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const popupRef = React.useRef<Window | null>(null);
  const readyRef = React.useRef(false);
  // Live was requested before the console had loaded; start it on 'voice:ready'.
  // `resume` marks a hand-off from a session that was already live (pop-out),
  // which the console treats differently — see App.tsx.
  const pendingLiveRef = React.useRef<{ resume: boolean } | null>(null);

  const popupIsOpen = () => !!popupRef.current && !popupRef.current.closed;
  const target = (): Window | null =>
    popupIsOpen() ? popupRef.current : iframeRef.current?.contentWindow ?? null;
  const send = (on: boolean, resume = false) =>
    target()?.postMessage({ type: 'voice:set-live', on, resume }, window.location.origin);

  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || typeof e.data?.type !== 'string') return;
      const fromOurs =
        (iframeRef.current && e.source === iframeRef.current.contentWindow) ||
        (popupRef.current && e.source === popupRef.current);
      if (!fromOurs) return;
      if (e.data.type === 'voice:ready') {
        readyRef.current = true;
        if (pendingLiveRef.current) {
          const { resume } = pendingLiveRef.current;
          pendingLiveRef.current = null;
          send(true, resume);
        }
      } else if (e.data.type === 'voice:state') {
        setLive(!!e.data.live);
        setSpeaking(!!e.data.speaking);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // A closed pop-out can't say goodbye; notice it, and free Live for docking.
  React.useEffect(() => {
    const id = window.setInterval(() => {
      if (popupRef.current && popupRef.current.closed) {
        popupRef.current = null;
        readyRef.current = false;
        setLive(false);
        setSpeaking(false);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const toggleLive = () => {
    if (live) {
      send(false);
      return;
    }
    if (readyRef.current && target()) {
      send(true);
    } else {
      pendingLiveRef.current = { resume: false };
      setMounted(true);
    }
  };

  const togglePane = () => {
    // The console is in its own window; bring that forward rather than
    // docking a second one (two consoles would fight over the mic).
    if (popupIsOpen()) {
      popupRef.current?.focus();
      return;
    }
    setMounted(true);
    setPaneOpen((v) => !v);
  };

  const moveToWindow = () => {
    const win = window.open(VOICE_URL, POPOUT_NAME, POPOUT_FEATURES);
    if (!win) return; // blocked by the browser; keep the pane and its session
    popupRef.current = win;
    readyRef.current = false;
    // A Gemini session can't be handed between pages, so "preserving" live means
    // the window starts a fresh one as soon as it loads. Unmounting the docked
    // console closes its socket, which closes its session server-side. The Live
    // button keeps showing live throughout; the window's own state reports
    // replace it. (The conversation's context doesn't carry over — memory does.)
    if (live) pendingLiveRef.current = { resume: true };
    setPaneOpen(false);
    setMounted(false);
  };

  const liveButton = showLabels ? (
    <Button
      variant="outline"
      size="sm"
      onClick={toggleLive}
      aria-pressed={live}
      className={cn('shrink-0 gap-1.5', live && 'border-emerald-500/60 text-emerald-600 dark:text-emerald-400')}
    >
      <Mic className={cn('size-3.5', speaking && 'animate-pulse')} />
      Live
    </Button>
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          mode="icon"
          size="sm"
          onClick={toggleLive}
          aria-pressed={live}
          aria-label="Live voice"
          className={cn(live && 'text-emerald-600 dark:text-emerald-400')}
        >
          <Mic className={cn('size-4', speaking && 'animate-pulse')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{live ? 'End live voice' : 'Go live'}</TooltipContent>
    </Tooltip>
  );

  const paneButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          mode="icon"
          size="sm"
          onClick={togglePane}
          aria-pressed={paneOpen}
          aria-label="Voice console"
          className="text-muted-foreground"
        >
          <AppWindow className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">Voice console</TooltipContent>
    </Tooltip>
  );

  const console_ = mounted
    ? createPortal(
        <div
          role={paneOpen ? 'dialog' : undefined}
          aria-label="Live voice"
          aria-hidden={!paneOpen}
          className={cn(
            'fixed z-50 flex h-[min(680px,80vh)] w-[min(460px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl',
            paneOpen ? 'right-4 bottom-4' : 'pointer-events-none top-0 left-[-10000px]',
          )}
        >
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
            <span className="flex items-center gap-1.5 text-xs font-semibold">
              <span className={cn('size-1.5 rounded-full', live ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/40')} />
              {live ? 'Live' : 'Voice console'}
            </span>
            <div className="flex items-center gap-0.5">
              <Button variant="ghost" mode="icon" size="sm" onClick={moveToWindow} aria-label="Open in a window" title="Open in a window">
                <ExternalLink className="size-3.5" />
              </Button>
              <Button variant="ghost" mode="icon" size="sm" onClick={() => setPaneOpen(false)} aria-label="Hide" title="Hide (stays live)">
                <X className="size-3.5" />
              </Button>
            </div>
          </div>
          <iframe
            ref={iframeRef}
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
      <div className={cn('flex items-center gap-0.5', !showLabels && 'flex-col')}>
        {liveButton}
        {paneButton}
      </div>
      {console_}
    </>
  );
}
