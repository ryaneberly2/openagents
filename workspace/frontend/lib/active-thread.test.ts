import { describe, expect, it } from 'vitest';
import { activeThreadPayload } from './active-thread';

const sessions = [
  { sessionId: 'channel-ad8a015a', title: 'Admin Config' },
  { sessionId: 'channel-00000001', title: null },
];

describe('activeThreadPayload', () => {
  it('is null when no thread is selected', () => {
    expect(activeThreadPayload(null, sessions)).toBeNull();
  });

  it('carries the channel id and its title', () => {
    expect(activeThreadPayload('channel-ad8a015a', sessions)).toEqual({ channel: 'channel-ad8a015a', title: 'Admin Config' });
  });

  it('keeps an untitled or not-yet-loaded thread with a null title', () => {
    expect(activeThreadPayload('channel-00000001', sessions)).toEqual({ channel: 'channel-00000001', title: null });
    expect(activeThreadPayload('dm:human:user,openagents:insight', sessions)).toEqual({ channel: 'dm:human:user,openagents:insight', title: null });
  });
});
