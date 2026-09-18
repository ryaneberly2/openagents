'use strict';

/**
 * Unit tests for the pure ACP protocol helpers (no process, no network).
 * See devin-acp.js's file header for the protocol citations these encode.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const acp = require('../src/adapters/devin-acp');

describe('devin-acp — NDJSON framing', () => {
  it('encodes a message as exactly one line', () => {
    const line = acp.encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } });
    assert.equal(line.endsWith('\n'), true);
    assert.equal(line.slice(0, -1).includes('\n'), false);
    assert.deepEqual(JSON.parse(line), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } });
  });

  it('a value with newlines inside a string field stays on one wire line', () => {
    const line = acp.encodeMessage({ jsonrpc: '2.0', method: 'session/update', params: { text: 'line1\nline2' } });
    assert.equal(line.trim().split('\n').length, 1);
    assert.equal(JSON.parse(line).params.text, 'line1\nline2');
  });

  it('decodes messages split arbitrarily across chunks', () => {
    const received = [];
    const decoder = acp.createLineDecoder((m) => received.push(m));
    const full = acp.encodeMessage({ id: 1, result: 'a' }) + acp.encodeMessage({ id: 2, result: 'b' });
    // Split mid-line, mid-object, to prove buffering works byte-for-byte.
    decoder.push(full.slice(0, 5));
    decoder.push(full.slice(5, 20));
    decoder.push(full.slice(20));
    assert.deepEqual(received, [{ id: 1, result: 'a' }, { id: 2, result: 'b' }]);
  });

  it('skips a malformed line and reports it, without losing later valid ones', () => {
    const received = [];
    const errors = [];
    const decoder = acp.createLineDecoder((m) => received.push(m), (line) => errors.push(line));
    decoder.push('not json at all\n');
    decoder.push(acp.encodeMessage({ id: 1, result: 'ok' }));
    assert.equal(errors.length, 1);
    assert.deepEqual(received, [{ id: 1, result: 'ok' }]);
  });

  it('flush() emits a trailing line with no terminating newline (process exit mid-line)', () => {
    const received = [];
    const decoder = acp.createLineDecoder((m) => received.push(m));
    decoder.push(JSON.stringify({ id: 9, result: 'x' })); // no trailing \n
    assert.equal(received.length, 0, 'not emitted until flushed');
    decoder.flush();
    assert.deepEqual(received, [{ id: 9, result: 'x' }]);
  });

  it('ignores blank lines', () => {
    const received = [];
    const decoder = acp.createLineDecoder((m) => received.push(m));
    decoder.push('\n\n' + acp.encodeMessage({ id: 1, result: 'ok' }) + '\n');
    assert.deepEqual(received, [{ id: 1, result: 'ok' }]);
  });
});

describe('devin-acp — message builders', () => {
  it('initialize carries protocolVersion 1 and no fs/terminal client capabilities', () => {
    const req = acp.buildInitializeRequest(1, { clientVersion: '1.2.3' });
    assert.equal(req.method, 'initialize');
    assert.equal(req.params.protocolVersion, acp.PROTOCOL_VERSION);
    assert.equal(req.params.clientCapabilities.fs.readTextFile, false);
    assert.equal(req.params.clientCapabilities.fs.writeTextFile, false);
    assert.equal(req.params.clientCapabilities.terminal, false);
    assert.equal(req.params.clientInfo.version, '1.2.3');
  });

  it('session/new always includes mcpServers (schema requires it even when empty)', () => {
    const req = acp.buildNewSessionRequest(2, { cwd: '/tmp/work' });
    assert.equal(req.method, 'session/new');
    assert.equal(req.params.cwd, '/tmp/work');
    assert.deepEqual(req.params.mcpServers, []);
  });

  it('session/load carries sessionId, cwd and mcpServers', () => {
    const req = acp.buildLoadSessionRequest(3, { sessionId: 'sess-1', cwd: '/tmp/work', mcpServers: [{ name: 'x', command: 'y', args: [], env: [] }] });
    assert.equal(req.method, 'session/load');
    assert.equal(req.params.sessionId, 'sess-1');
    assert.equal(req.params.mcpServers.length, 1);
  });

  it('session/prompt wraps text in a single ContentBlock of type text', () => {
    const req = acp.buildPromptRequest(4, { sessionId: 's1', text: 'hello' });
    assert.equal(req.method, 'session/prompt');
    assert.deepEqual(req.params.prompt, [{ type: 'text', text: 'hello' }]);
  });

  it('session/cancel is a NOTIFICATION — no id field', () => {
    const note = acp.buildCancelNotification('s1');
    assert.equal(note.method, 'session/cancel');
    assert.equal('id' in note, false);
    assert.deepEqual(note.params, { sessionId: 's1' });
  });

  it('permission response echoes the request id with a result envelope', () => {
    const res = acp.buildPermissionResponse(7, { outcome: 'selected', optionId: 'allow_once' });
    assert.deepEqual(res, { jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
  });
});

describe('devin-acp — session/update interpretation', () => {
  it('maps agent_message_chunk to agent_text with the block text extracted', () => {
    const u = acp.interpretSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi there' } });
    assert.deepEqual(u, { kind: 'agent_text', text: 'hi there', messageId: null });
  });

  it('maps agent_thought_chunk to agent_thought', () => {
    const u = acp.interpretSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } });
    assert.equal(u.kind, 'agent_thought');
    assert.equal(u.text, 'thinking...');
  });

  it('maps tool_call and tool_call_update with their kind/status', () => {
    const created = acp.interpretSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', kind: 'read', status: 'pending' });
    assert.equal(created.kind, 'tool_call');
    assert.equal(created.toolKind, 'read');
    const updated = acp.interpretSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    assert.equal(updated.kind, 'tool_call_update');
    assert.equal(updated.status, 'completed');
  });

  it('maps plan entries', () => {
    const u = acp.interpretSessionUpdate({
      sessionUpdate: 'plan',
      entries: [{ content: 'Step 1', status: 'completed', priority: 'high' }, { content: 'Step 2', status: 'in_progress', priority: 'medium' }],
    });
    assert.equal(u.kind, 'plan');
    assert.equal(u.entries.length, 2);
    assert.ok(acp.planToStatusText(u.entries).includes('Step 1'));
  });

  it('an unrecognized sessionUpdate degrades to "other", never throws', () => {
    const u = acp.interpretSessionUpdate({ sessionUpdate: 'some_future_variant', anything: 1 });
    assert.equal(u.kind, 'other');
  });

  it('a null/garbage update never throws', () => {
    assert.doesNotThrow(() => acp.interpretSessionUpdate(null));
    assert.doesNotThrow(() => acp.interpretSessionUpdate(undefined));
    assert.doesNotThrow(() => acp.interpretSessionUpdate('not an object'));
  });

  it('image/audio/resource content blocks render as bracketed placeholders, not empty text', () => {
    assert.equal(acp.contentBlockToText({ type: 'image' }), '[image]');
    assert.equal(acp.contentBlockToText({ type: 'audio' }), '[audio]');
    assert.equal(acp.contentBlockToText({ type: 'resource_link', uri: 'file:///a.txt' }), '[resource: file:///a.txt]');
  });
});

describe('devin-acp — permission-mode policy', () => {
  const OPTS = [
    { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'a2', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'r1', name: 'Reject once', kind: 'reject_once' },
    { optionId: 'r2', name: 'Reject always', kind: 'reject_always' },
  ];

  it('unrecognized/absent mode defaults to "smart", NOT a bypass', () => {
    assert.equal(acp.normalizePermissionMode(undefined), 'smart');
    assert.equal(acp.normalizePermissionMode('nonsense'), 'smart');
    assert.equal(acp.normalizePermissionMode(''), 'smart');
  });

  it('smart mode approves a read once, silently (no notice)', () => {
    const d = acp.decideDevinPermission({ options: OPTS, toolKind: 'read', mode: 'smart' });
    assert.equal(d.option.kind, 'allow_once');
    assert.equal(d.remembered, false);
    assert.equal(d.notice, null);
  });

  it('smart mode approves a risky (execute) call once, but narrates it', () => {
    const d = acp.decideDevinPermission({ options: OPTS, toolKind: 'execute', mode: 'smart' });
    assert.equal(d.option.kind, 'allow_once');
    assert.equal(d.remembered, false);
    assert.ok(d.notice && d.notice.length > 0);
  });

  it('smart mode never selects "allow_always" (never remembers)', () => {
    for (const kind of ['read', 'search', 'fetch', 'think', 'edit', 'execute', 'delete', 'move']) {
      const d = acp.decideDevinPermission({ options: OPTS, toolKind: kind, mode: 'smart' });
      assert.notEqual(d.option.kind, 'allow_always');
    }
  });

  it('accept-edits auto-approves edits without a notice, but narrates execute', () => {
    const edit = acp.decideDevinPermission({ options: OPTS, toolKind: 'edit', mode: 'accept-edits' });
    assert.equal(edit.notice, null);
    const exec = acp.decideDevinPermission({ options: OPTS, toolKind: 'execute', mode: 'accept-edits' });
    assert.ok(exec.notice);
  });

  it('bypass/dangerous/yolo prefer allow_always, silently', () => {
    for (const mode of ['bypass', 'dangerous', 'yolo']) {
      const d = acp.decideDevinPermission({ options: OPTS, toolKind: 'execute', mode });
      assert.equal(d.option.kind, 'allow_always');
      assert.equal(d.remembered, true);
      assert.equal(d.notice, null);
    }
  });

  it('autonomous behaves like bypass for the permission decision itself', () => {
    const d = acp.decideDevinPermission({ options: OPTS, toolKind: 'execute', mode: 'autonomous' });
    assert.equal(d.option.kind, 'allow_always');
  });

  it('falls back gracefully when no "allow" option is offered at all', () => {
    const onlyReject = [{ optionId: 'r1', name: 'Reject', kind: 'reject_once' }];
    const d = acp.decideDevinPermission({ options: onlyReject, toolKind: 'execute', mode: 'smart' });
    assert.equal(d.option.optionId, 'r1');
  });

  it('no options offered at all: refuses to fabricate a choice', () => {
    const d = acp.decideDevinPermission({ options: [], toolKind: 'execute', mode: 'bypass' });
    assert.equal(d.option, null);
    assert.ok(d.notice);
  });
});

describe('devin-acp — argv', () => {
  it('always passes --respect-workspace-trust false ahead of the acp subcommand', () => {
    const args = acp.buildDevinAcpArgs({});
    assert.deepEqual(args.slice(0, 2), ['--respect-workspace-trust', 'false']);
    assert.ok(args.includes('acp'));
  });

  it('passes --model only when configured', () => {
    assert.ok(!acp.buildDevinAcpArgs({}).includes('--model'));
    const withModel = acp.buildDevinAcpArgs({ model: 'opus' });
    assert.equal(withModel[withModel.indexOf('--model') + 1], 'opus');
  });

  it('passes --sandbox only in autonomous mode', () => {
    assert.ok(!acp.buildDevinAcpArgs({}).includes('--sandbox'));
    assert.ok(acp.buildDevinAcpArgs({ autonomous: true }).includes('--sandbox'));
  });
});

describe('devin-acp — version parsing', () => {
  it('parses a plain dotted version', () => {
    assert.equal(acp.parseDevinVersion('devin 1.4.2'), '1.4.2');
    assert.equal(acp.parseDevinVersion('1.4.2-beta.1'), '1.4.2');
  });
  it('returns null for unparseable input', () => {
    assert.equal(acp.parseDevinVersion(''), null);
    assert.equal(acp.parseDevinVersion(null), null);
    assert.equal(acp.parseDevinVersion('not a version'), null);
  });
});

describe('devin-acp — redaction', () => {
  it('redacts an API key embedded in a frame before logging', () => {
    const out = acp.redactFrameForLog({ params: { env: { WINDSURF_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz1234567890' } } });
    assert.ok(!out.includes('sk-abcdefghijklmnopqrstuvwxyz1234567890'), 'the raw key must never survive redaction');
  });

  it('truncates long frames', () => {
    const out = acp.redactFrameForLog({ text: 'x'.repeat(1000) }, 50);
    assert.ok(out.length <= 51);
  });
});

describe('devin-acp — live model catalog', () => {
  // Fixture shape matches a real `devin models list --format json` response
  // (captured against a live, authenticated Devin Pro account, 2026-09-18),
  // trimmed to two families.
  const FIXTURE = {
    families: [
      {
        family_label: 'Claude Opus 5',
        family_uid: 'claude-opus-5',
        slug: 'claude-opus-5',
        aliases: ['opus'],
        variants: [
          { model_uid: 'claude-opus-5-medium', label: 'Claude Opus 5 Medium' },
          { model_uid: 'claude-opus-5-high', label: 'Claude Opus 5 High' },
        ],
      },
      {
        family_label: 'Claude Sonnet 5',
        family_uid: 'claude-sonnet-5',
        slug: 'claude-sonnet-5',
        aliases: ['claude', 'sonnet'],
        variants: [
          { model_uid: 'claude-sonnet-5-medium', label: 'Claude Sonnet 5 Medium' },
        ],
      },
    ],
  };

  it('collects every variant id, family slug/uid, and alias, lowercased', () => {
    const { ids } = acp.flattenModelsCatalog(FIXTURE);
    for (const expected of [
      'claude-opus-5-medium', 'claude-opus-5-high', 'opus',
      'claude-sonnet-5-medium', 'claude', 'sonnet', 'claude-sonnet-5',
    ]) {
      assert.ok(ids.has(expected), `expected "${expected}" in the flattened id set`);
    }
    assert.ok(!ids.has('gpt-6-astra'), 'must not invent ids absent from the fixture');
  });

  it('is case-insensitive by construction (ids are stored lowercase)', () => {
    const { ids } = acp.flattenModelsCatalog(FIXTURE);
    assert.ok(ids.has('opus'));
    assert.ok(!ids.has('Opus'), 'callers are expected to lowercase before checking membership');
  });

  it('reports family labels and variant counts for logging', () => {
    const { families } = acp.flattenModelsCatalog(FIXTURE);
    assert.equal(families.length, 2);
    assert.equal(families[0].label, 'Claude Opus 5');
    assert.equal(families[0].variantCount, 2);
    assert.equal(families[1].variantCount, 1);
  });

  it('degrades to empty, never throws, on malformed input', () => {
    for (const bad of [null, undefined, {}, { families: null }, { families: 'nope' }, 'a string', 42]) {
      const { ids, families } = acp.flattenModelsCatalog(bad);
      assert.equal(ids.size, 0);
      assert.deepEqual(families, []);
    }
  });
});
