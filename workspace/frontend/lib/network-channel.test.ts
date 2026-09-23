import { describe, expect, it } from 'vitest';
import { networkChannelToSession } from './types';
import type { NetworkChannel } from './types';

const channel = (over: Partial<NetworkChannel>): NetworkChannel => ({
  address: 'channel/channel-9f9c79d8',
  title: 'UI Configuration Grouping',
  master: null,
  participants: [],
  created_at: null,
  last_event_at: null,
  status: 'active',
  starred: false,
  ...over,
});

describe('networkChannelToSession participants', () => {
  it('reads an address-form participant as the bare agent name it is looked up by', () => {
    // Regression: `openagents:forge-2-devin` never matched an agent named
    // `forge-2-devin`, so the thread showed "No agent in this thread is online"
    // while that agent was mid-task.
    const s = networkChannelToSession(channel({ participants: ['openagents:forge-2-devin'] }), 'ws');
    expect(s.participants).toEqual(['forge-2-devin']);
  });

  it('leaves bare names alone and keeps humans distinguishable', () => {
    const s = networkChannelToSession(channel({ participants: ['insight', 'human:user'] }), 'ws');
    expect(s.participants).toEqual(['insight', 'human:user']);
  });

  it('does not list one agent twice when it was added under both forms', () => {
    const s = networkChannelToSession(
      channel({ participants: ['forge-2-devin', 'openagents:forge-2-devin', 'insight'] }),
      'ws',
    );
    expect(s.participants).toEqual(['forge-2-devin', 'insight']);
  });

  it('normalizes the master too', () => {
    const s = networkChannelToSession(channel({ master: 'openagents:insight', participants: ['insight'] }), 'ws');
    expect(s.master).toBe('insight');
  });
});
