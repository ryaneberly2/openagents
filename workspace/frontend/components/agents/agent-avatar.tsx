import { useMemo } from 'react';
import { createAvatar } from '@dicebear/core';
import { bigSmile } from '@dicebear/collection';
import { cn } from '@/lib/utils';

// The built-in Yumi assistant has a fixed brand avatar instead of a generated
// one. Its agent name is reserved/unique (provider "openagents"), so matching
// on the name is sufficient to identify it wherever an avatar is rendered.
const YUMI_AVATAR_SRC = '/yumi-avatar.png';
const isYumi = (name: string) => (name || '').toLowerCase() === 'yumi';

interface AgentAvatarProps {
  name: string;
  size?: number;
  status?: string;
  showStatus?: boolean;
  className?: string;
  square?: boolean;
}

export function AgentAvatar({ name, size = 28, status, showStatus = false, className, square = false }: AgentAvatarProps) {
  // Deterministic on `name` alone — same seed in, same face+color out, same
  // guarantee boring-avatars gave (no per-agent-type icon; two agents with
  // different names always render differently). Memoized since createAvatar
  // does real work (SVG generation) on every call.
  const dataUri = useMemo(
    () => createAvatar(bigSmile, { seed: name }).toDataUri(),
    [name],
  );
  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }}>
      <div className={cn(square ? 'rounded-lg' : 'rounded-full', 'overflow-hidden')} style={{ width: size, height: size }}>
        {isYumi(name) ? (
          <img
            src={YUMI_AVATAR_SRC}
            alt="Yumi"
            width={size}
            height={size}
            className="size-full object-cover"
            draggable={false}
          />
        ) : (
          <img src={dataUri} alt={name} width={size} height={size} className="size-full object-cover" draggable={false} />
        )}
      </div>
      {showStatus && (
        <span className={cn(
          'absolute -bottom-0.5 -right-0.5 rounded-full border-[1.5px] border-background',
          size >= 28 ? 'size-2.5' : 'size-2',
          status === 'online' ? 'bg-green-500' : 'bg-zinc-300 dark:bg-zinc-600'
        )} />
      )}
    </div>
  );
}
