import { describe, expect, it } from 'vitest';
import { activeThreadPayload, activeViewPayload, type ActiveViewInput } from './active-thread';

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

describe('activeViewPayload', () => {
  const base: ActiveViewInput = {
    mode: 'threads',
    sessionId: 'channel-ad8a015a',
    sessions,
    selectedFileId: 'f1',
    files: [{ id: 'f1', filename: 'briefing.html' }],
    currentFilePath: 'uploaded_files',
    selectedBrowserTabId: 't1',
    browserTabs: [{ id: 't1', title: 'Example', url: 'https://example.com/' }],
  };

  it('threads: only the open thread', () => {
    expect(activeViewPayload(base)).toEqual({ mode: 'threads', thread: { channel: 'channel-ad8a015a', title: 'Admin Config' } });
  });

  it('files: the previewed file and its folder, not the last thread', () => {
    expect(activeViewPayload({ ...base, mode: 'files' })).toEqual({
      mode: 'files', file: { id: 'f1', filename: 'briefing.html' }, folder: 'uploaded_files',
    });
    expect(activeViewPayload({ ...base, mode: 'files', selectedFileId: null, currentFilePath: '' }))
      .toEqual({ mode: 'files', file: null, folder: null });
  });

  it('browser: the selected tab', () => {
    expect(activeViewPayload({ ...base, mode: 'browser' })).toEqual({
      mode: 'browser', browser_tab: { id: 't1', title: 'Example', url: 'https://example.com/' },
    });
  });

  it('other views: just the mode', () => {
    expect(activeViewPayload({ ...base, mode: 'knowledge' })).toEqual({ mode: 'knowledge' });
    expect(activeViewPayload({ ...base, mode: null })).toEqual({ mode: null });
  });
});
