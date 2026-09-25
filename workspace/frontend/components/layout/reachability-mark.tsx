'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { REACHABILITY_TITLE, useReachability } from '@/lib/reachability';

/**
 * Wraps the workspace logo. While the workspace is reachable it renders the
 * logo unchanged; when the session in front of it has ended (sign-in needed)
 * or the workspace can't be reached, the logo gets a red ring and dot, a
 * tooltip saying which, and becomes a button that reloads the page — which is
 * what brings up the sign-in page again.
 */
export function ReachabilityMark({ children, className }: { children: ReactNode; className?: string }) {
  const state = useReachability();
  const bad = state === 'login' || state === 'offline';
  if (!bad) return <span className={cn('relative inline-flex', className)}>{children}</span>;
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      title={REACHABILITY_TITLE[state]}
      aria-label={REACHABILITY_TITLE[state]}
      className={cn('relative inline-flex cursor-pointer rounded-full ring-2 ring-destructive ring-offset-2 ring-offset-background', className)}
    >
      {children}
      <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-destructive ring-2 ring-background" aria-hidden="true" />
    </button>
  );
}
