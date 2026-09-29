import { describe, expect, it } from 'vitest';
import { commandSource, isForThisTab, parseUiCommand, safeLink } from './ui-commands';

describe('parseUiCommand', () => {
  it('accepts open_thread and strips a channel/ prefix', () => {
    expect(parseUiCommand({ action: 'open_thread', args: { channel: 'channel/channel-ad8a015a' } }))
      .toEqual({ ok: true, command: { action: 'open_thread', channel: 'channel-ad8a015a' } });
  });

  it('accepts open_file', () => {
    expect(parseUiCommand({ action: 'open_file', args: { file_id: 'f-1' } }))
      .toEqual({ ok: true, command: { action: 'open_file', fileId: 'f-1' } });
  });

  it('accepts notify with and without an http(s) link', () => {
    expect(parseUiCommand({ action: 'notify', args: { text: 'hi' } }))
      .toEqual({ ok: true, command: { action: 'notify', text: 'hi' } });
    expect(parseUiCommand({ action: 'notify', args: { text: 'hi', link: 'http://seradexsupportvm:8888/faramir/', link_label: 'Open' } }))
      .toEqual({ ok: true, command: { action: 'notify', text: 'hi', link: 'http://seradexsupportvm:8888/faramir/', linkLabel: 'Open' } });
  });

  it('refuses a non-http link', () => {
    const r = parseUiCommand({ action: 'notify', args: { text: 'hi', link: 'javascript:alert(1)' } });
    expect(r.ok).toBe(false);
  });

  it('refuses unknown actions and missing args', () => {
    expect(parseUiCommand({ action: 'delete_thread', args: { channel: 'x' } }).ok).toBe(false);
    expect(parseUiCommand({ action: 'open_thread', args: {} }).ok).toBe(false);
    expect(parseUiCommand({ action: 'notify', args: { text: 'x'.repeat(501) } }).ok).toBe(false);
    expect(parseUiCommand(null).ok).toBe(false);
  });
});

describe('safeLink', () => {
  it('only passes absolute http(s) URLs', () => {
    expect(safeLink('https://example.com/a')).toBe('https://example.com/a');
    expect(safeLink('data:text/html,x')).toBeNull();
    expect(safeLink('/relative')).toBeNull();
    expect(safeLink(42)).toBeNull();
  });
});

describe('isForThisTab', () => {
  it('matches its own tab or an untargeted command', () => {
    expect(isForThisTab({ tab_id: 't1' }, 't1')).toBe(true);
    expect(isForThisTab({}, 't1')).toBe(true);
    expect(isForThisTab({ tab_id: 't2' }, 't1')).toBe(false);
  });
});

describe('commandSource', () => {
  it('prefers payload.from, else the event source without its prefix', () => {
    expect(commandSource('claude (host)', 'openagents:workspace-mcp')).toBe('claude (host)');
    expect(commandSource(undefined, 'openagents:workspace-mcp')).toBe('workspace-mcp');
    expect(commandSource('', '')).toBe('an agent');
  });
});
