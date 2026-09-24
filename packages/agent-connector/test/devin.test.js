'use strict';

/**
 * Contract tests for DevinAdapter against a FAKE Agent Client Protocol peer —
 * a small scripted Node process (below) that speaks the real ACP wire format
 * (newline-delimited JSON-RPC 2.0) but is not the real `devin` binary. No
 * network, no credentials, no real Devin CLI required — safe for the default
 * `npm test` suite.
 *
 * The gated real-binary end-to-end test lives in devin-e2e.test.js
 * (skipped unless DEVIN_E2E=1 and a real, authenticated `devin` is present).
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DevinAdapter = require('../src/adapters/devin');
const { ADAPTER_MAP, createAdapter } = require('../src/adapters');

// ---------------------------------------------------------------------------
// The fake ACP peer. Reads NDJSON JSON-RPC from stdin, writes NDJSON JSON-RPC
// to stdout, and behaves according to FAKE_SCENARIO. Every scenario is a real
// exercise of the wire format devin-acp.js implements — not a stub of the
// adapter's own code.
// ---------------------------------------------------------------------------
const FAKE_PEER_SCRIPT = `
'use strict';
const fs = require('fs');

// _refreshAvailableModels() invokes the SAME fake binary with
// ['models', 'list', '--format', 'json'] rather than ['acp'] — branch here,
// before any of the ACP stdin/stdout wiring below, and exit immediately.
if (process.argv.includes('models') && process.argv.includes('list')) {
  if (process.env.FAKE_MODELS_FAIL === '1') {
    process.stderr.write('not logged in\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    families: [
      { family_label: 'Claude Opus 5', family_uid: 'claude-opus-5', slug: 'claude-opus-5',
        aliases: ['opus'],
        variants: [{ model_uid: 'claude-opus-5-medium', label: 'Claude Opus 5 Medium' }] },
      { family_label: 'Claude Sonnet 5', family_uid: 'claude-sonnet-5', slug: 'claude-sonnet-5',
        aliases: ['claude', 'sonnet'],
        variants: [{ model_uid: 'claude-sonnet-5-medium', label: 'Claude Sonnet 5 Medium' }] },
    ],
  }));
  process.exit(0);
}

let buf = '';
let sessionCounter = 0;
let authenticated = process.env.FAKE_PRE_AUTHED === '1';
let sessionId = null;
let cancelRequested = false;
let permissionResponseWaiters = [];
const scenario = process.env.FAKE_SCENARIO || 'success';

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function err(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }
function update(sid, upd) { notify('session/update', { sessionId: sid, update: upd }); }

let nextReqId = 1000000;
function request(method, params) {
  return new Promise((resolve) => {
    const id = nextReqId++;
    const onLine = (msg) => {
      if (msg.id === id) resolve(msg);
    };
    pendingResponseHandlers.push(onLine);
    send({ jsonrpc: '2.0', id, method, params });
  });
}
const pendingResponseHandlers = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function handlePrompt(id, params) {
  sessionId = params.sessionId;
  if (process.env.FAKE_PROMPT_CAPTURE) {
    try { fs.appendFileSync(process.env.FAKE_PROMPT_CAPTURE, JSON.stringify(params.prompt) + '\\n---PROMPT---\\n'); } catch {}
  }
  if (scenario === 'success') {
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reasoning about the request...' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me read that file first.' } });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Reading file', kind: 'read', status: 'in_progress' });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    // Deliberately no messageId — the real devin acp never sends one
    // (found 2026-09-19; see appendMessageChunk's own comment). These must
    // still concatenate into "Hello from Devin.", not two separate lines.
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'from Devin.' } });
    update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'Do the thing', status: 'completed', priority: 'high' }] });
    ok(id, { stopReason: 'end_turn' });
    return;
  }
  if (scenario === 'status-burst') {
    // Four distinct tool calls fired synchronously, one after another, with
    // no await between them — the same shape a real fast tool-call stream
    // takes, and (before the dispatch-ordering fix) the shape that let
    // overlapping un-awaited sendStatus() calls race and post out of order.
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'first', title: 'first-tool', kind: 'execute', status: 'in_progress' });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'second', title: 'second-tool', kind: 'execute', status: 'in_progress' });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'third', title: 'third-tool', kind: 'execute', status: 'in_progress' });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'fourth', title: 'fourth-tool', kind: 'execute', status: 'in_progress' });
    ok(id, { stopReason: 'end_turn' });
    return;
  }
  if (scenario === 'thought-burst') {
    // A burst of thought deltas: two share a messageId (word/token-level
    // pieces of ONE thought) and two more arrive as separate thoughts (no
    // messageId) — all with no await between them, then the turn ends with
    // no intervening tool_call/text/plan to trigger an earlier flush.
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Check' }, messageId: 'th-1' });
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'ing the ' }, messageId: 'th-1' });
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'build.' }, messageId: 'th-1' });
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Looks clean.' } });
    ok(id, { stopReason: 'end_turn' });
    return;
  }
  if (scenario === 'permission') {
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'rm -rf build/', kind: 'execute', status: 'pending' });
    const permReq = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 't1', kind: 'execute' },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
      ],
    });
    const outcome = permReq.result && permReq.result.outcome;
    fs.writeFileSync(process.env.FAKE_PERMISSION_CAPTURE, JSON.stringify(outcome));
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: outcome && outcome.optionId === 'allow_once' ? 'completed' : 'failed' });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done handling permission.' } });
    ok(id, { stopReason: 'end_turn' });
    return;
  }
  if (scenario === 'cancel') {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Starting a long task...' } });
    const start = Date.now();
    while (!cancelRequested && Date.now() - start < 15000) {
      await sleep(50);
    }
    if (cancelRequested) {
      ok(id, { stopReason: 'cancelled' });
    } else {
      ok(id, { stopReason: 'end_turn' });
    }
    return;
  }
  if (scenario === 'crash_mid_turn') {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'about to die...' } });
    await sleep(100);
    process.exit(1);
  }
  if (scenario === 'wedge_then_recover') {
    // First invocation (no marker file yet): never respond at all — a
    // genuine silent wedge. Each retry is a FRESH process (a new devin
    // binary invocation, not a resumed in-memory one), so a marker FILE is
    // how this fake peer tells "first attempt" from "the retry" apart.
    const marker = process.env.FAKE_WEDGE_MARKER;
    if (marker && !fs.existsSync(marker)) {
      fs.writeFileSync(marker, '1');
      return;
    }
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Recovered fine.' } });
    ok(id, { stopReason: 'end_turn' });
    return;
  }
  if (scenario === 'always_wedged') {
    // Never responds, on every invocation, including the retry — proves
    // recovery is attempted exactly once, not forever.
    return;
  }
  if (scenario === 'long_tool_call_no_wedge') {
    // Silent for longer than the (test-shortened) silence watchdog, but with
    // a tool_call legitimately in_progress the whole time — this must NOT
    // be treated as a wedge (the real-world case: a multi-minute build).
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Building...', kind: 'execute', status: 'in_progress' });
    await sleep(150);
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Build finished.' } });
    ok(id, { stopReason: 'end_turn' });
    return;
  }
  if (scenario === 'malformed_stream') {
    for (let i = 0; i < 8; i++) process.stdout.write('not json at all ' + i + '\\n');
    // never respond — the parse-error threshold should trip first
    return;
  }
  if (scenario === 'protocol_error') {
    err(id, -32603, 'internal error simulated');
    return;
  }
  // default: just end the turn with nothing said
  ok(id, { stopReason: 'end_turn' });
}

function onMessage(msg) {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    for (const h of pendingResponseHandlers) h(msg);
    return;
  }
  if (msg.method === 'initialize') {
    ok(msg.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: process.env.FAKE_LOAD_SESSION !== '0', promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      authMethods: scenario === 'auth_required' ? [{ id: 'api-key' }] : [],
      agentInfo: { name: 'fake-devin', version: '0.0.0-fake' },
    });
    return;
  }
  if (msg.method === 'authenticate') {
    authenticated = true;
    ok(msg.id, {});
    return;
  }
  if (msg.method === 'session/new') {
    if (scenario === 'auth_required' && !authenticated) {
      err(msg.id, -32000, 'Authentication required');
      return;
    }
    // Include the pid: each channel gets its OWN fake-peer process (one
    // devin acp process per channel, by design — see devin.js's file
    // header), so a per-process counter alone would coincidentally produce
    // the same id ("sess-1") in two different, unrelated processes and mask
    // a real cross-channel leakage bug.
    sessionId = 'sess-' + process.pid + '-' + (++sessionCounter);
    ok(msg.id, { sessionId });
    return;
  }
  if (msg.method === 'session/load') {
    if (scenario === 'reject_load') {
      err(msg.id, -32002, 'session not found');
      return;
    }
    update(msg.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '(replayed history)' } });
    ok(msg.id, {});
    return;
  }
  if (msg.method === 'session/prompt') {
    handlePrompt(msg.id, msg.params);
    return;
  }
  if (msg.method === 'session/cancel') {
    cancelRequested = true;
    return; // notification — no response
  }
}

process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf-8');
  const lines = buf.split('\\n');
  buf = lines.pop();
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let m;
    try { m = JSON.parse(t); } catch { continue; }
    onMessage(m);
  }
});
process.stdin.resume();
`;

let tmpRoot;
let fakeBin;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-devin-'));
  fakeBin = path.join(tmpRoot, 'fake-devin.js');
  fs.writeFileSync(fakeBin, FAKE_PEER_SCRIPT, { mode: 0o755 });
});

const SESSIONS_FILE = path.join(os.homedir(), '.openagents', 'sessions', 'ws-devin-test_devin-bot_devin.json');
const SESSION_MODELS_FILE = SESSIONS_FILE.replace(/\.json$/, '_models.json');

// Every adapter this file creates spawns real (fake-peer) child processes
// that, by design, stay alive across turns (that is the whole point of a
// persistent ACP peer — see devin.js's file header). Nothing in a single test
// tears them down, so without this the node:test process never exits: it
// waits for the event loop to drain, and a live child process with open
// stdio pipes keeps it non-empty. `adapter.stop()` kills every peer's process
// tree (the same path a daemon shutdown takes), so run it for everything
// created, after every test.
const liveAdapters = [];
afterEach(async () => {
  const pending = [];
  while (liveAdapters.length) {
    const a = liveAdapters.pop();
    try { pending.push(Promise.resolve(a.stop())); } catch {}
  }
  await Promise.all(pending.map((p) => p.catch(() => {})));
});

after(async () => {
  // Best-effort: a lingering child process (see below) can still hold tmpRoot
  // as its cwd for a moment, which makes an immediate rmSync throw EPERM on
  // Windows. Not fatal — it's a tmp dir, the OS cleans it eventually.
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(SESSIONS_FILE, { force: true }); } catch {}
  try { fs.rmSync(SESSION_MODELS_FILE, { force: true }); } catch {}

  // Every adapter's peer process is stopped (and its stdio streams destroyed)
  // by the per-test afterEach above. Direct `process._getActiveHandles()`
  // inspection during development of this suite showed that on this platform
  // a forcefully-terminated child's pipe handles can still linger in the
  // active-handle set for a while after the OS process itself is gone — and
  // that alone is enough to keep `node --test`'s own event loop non-empty far
  // longer than any test or hook here waits around for, hanging this file's
  // process even though every test has already passed and reported. Since
  // `node --test test/*.test.js` runs each file in its own subprocess (see
  // package.json), forcing this one to exit — preserving whatever exit code
  // the test runner already decided — cannot affect any other test file's
  // result.
  await new Promise((r) => setTimeout(r, 250));
  process.exit(process.exitCode || 0);
});

beforeEach(() => {
  try { fs.rmSync(SESSIONS_FILE, { force: true }); } catch {}
  try { fs.rmSync(SESSION_MODELS_FILE, { force: true }); } catch {}
});

function makeAdapter(extra = {}) {
  const a = new DevinAdapter({
    workspaceId: 'ws-devin-test',
    channelName: 'thread',
    token: 'token',
    agentName: 'devin-bot',
    agentType: 'devin',
    endpoint: 'https://example.invalid',
    agentEnv: {
      ...(extra.agentEnv || {}),
      FAKE_SCENARIO: extra.scenario || 'success',
      ...(extra.env || {}),
    },
    workingDir: extra.workingDir || tmpRoot,
  });
  a._captured = { thinking: [], status: [], response: [], error: [], logs: [] };
  a.sendThinking = async (_c, t) => { a._captured.thinking.push(t); };
  a.sendStatus = async (_c, t) => { a._captured.status.push(t); };
  a.sendResponse = async (_c, t) => { a._captured.response.push(t); };
  a.sendError = async (_c, t) => { a._captured.error.push(t); };
  const realLog = (m) => { a._captured.logs.push(String(m)); };
  a._log = realLog;
  a.client = {
    getSession: async () => ({ title: 'Session 1', titleManuallySet: false, resumeFrom: null }),
    updateSession: async () => ({}),
  };
  // The spawned "binary" is our fake ACP peer script. devin.js detects a
  // .js/.mjs resolution and runs it through THIS node interpreter (see the
  // comment in devin.js's _ensurePeer) — spawning a .js file directly only
  // works on POSIX via its shebang, never on Windows.
  a._findDevinBinary = () => fakeBin;
  liveAdapters.push(a);
  return a;
}

const send = (a, content = 'do the thing') =>
  a._handleMessage({ content, sessionId: 'thread', senderType: 'human', senderName: 'user' });

describe('DevinAdapter — registration', () => {
  it('is reachable through the adapter registry', () => {
    assert.ok(ADAPTER_MAP.devin);
    const a = createAdapter('devin', {
      workspaceId: 'w', channelName: 'c', token: 't', agentName: 'n', endpoint: 'https://e', agentEnv: {},
    });
    assert.equal(a.constructor.name, 'DevinAdapter');
  });

  it('preflight() reports runtime_missing with an install hint when the binary cannot be resolved', () => {
    const a = makeAdapter();
    a._findDevinBinary = () => null;
    const result = a.preflight();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'runtime_missing');
    assert.ok(/devin/i.test(result.message));
  });
});

describe('DevinAdapter — initialize, session creation, first turn', () => {
  it('initializes, creates a session, streams progress and posts a final answer', async () => {
    const a = makeAdapter({ scenario: 'success' });
    await send(a, 'read the file and summarize it');

    // Reasoning streams to the gray thinking channel, and mid-turn narration
    // (answer-text a tool call then follows) is flushed there — but the
    // trailing answer itself must NOT be duplicated into thinking: it posts
    // exactly once, as the final response.
    assert.ok(a._captured.thinking.some((t) => /Reasoning about the request/.test(t)), 'expected the thought chunk to stream');
    assert.ok(a._captured.thinking.some((t) => /Let me read that file first/.test(t)), 'expected mid-turn narration in thinking');
    assert.ok(!a._captured.thinking.some((t) => /Hello |from Devin/.test(t)), 'answer text must not be duplicated into the thinking stream');
    assert.ok(a._captured.status.some((s) => /Reading file/.test(s)), 'expected a tool_call status');
    assert.ok(a._captured.status.some((s) => /Do the thing/.test(s)), 'expected the plan to be posted');

    // Chunks sharing a messageId are concatenated, not one-per-line.
    assert.equal(a._captured.response.length, 1);
    assert.equal(a._captured.response[0], 'Hello from Devin.');
    assert.equal(a._captured.error.length, 0);

    // Session id persisted for the channel.
    const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    assert.match(saved.thread, /^sess-\d+-1$/);
  });

  it('posts a burst of tool-call statuses in emission order, even when their sendStatus() calls settle out of order', async () => {
    const a = makeAdapter({ scenario: 'status-burst' });
    // Deliberately reversed delays: the FIRST status emitted takes the
    // LONGEST to post. Without AcpPeer's update-dispatch queue, this is
    // exactly the shape that let a later, faster call post before an
    // earlier, slower one — scrambling the order the channel displays them
    // in (the same class of bug found 2026-09-18 from a real forge-2-devin
    // channel screenshot, there manifesting as scrambled thought chunks).
    const delayByLabel = { 'first-tool': 30, 'second-tool': 20, 'third-tool': 10, 'fourth-tool': 0 };
    a.sendStatus = async (_c, t) => {
      const label = Object.keys(delayByLabel).find((l) => t.includes(l));
      await new Promise((r) => setTimeout(r, delayByLabel[label] ?? 0));
      a._captured.status.push(t);
    };
    await send(a, 'run four things');

    const toolLabels = a._captured.status
      .map((s) => Object.keys(delayByLabel).find((l) => s.includes(l)))
      .filter(Boolean);
    assert.deepEqual(toolLabels, ['first-tool', 'second-tool', 'third-tool', 'fourth-tool']);
  });

  it('buffers thought chunks and flushes them as one message, concatenated correctly, at turn end', async () => {
    const a = makeAdapter({ scenario: 'thought-burst' });
    await send(a, 'check the build');

    // Same-messageId deltas concatenate directly (no separator); the
    // separate, message-id-less thought joins with a blank line — the exact
    // agent_text discipline, now applied to agent_thought too. One post
    // total, not four (found 2026-09-18: unbuffered, this was a wall of
    // one-word "thinking" messages in real forge/forge-2-devin channels).
    assert.deepEqual(a._captured.thinking, ['Checking the build.\n\nLooks clean.']);
  });

  it('prepends the workspace briefing to a new session\'s first prompt, and does not re-send it on resume', async () => {
    const capturePath = path.join(tmpRoot, `prompt-capture-${Date.now()}.txt`);
    const a = makeAdapter({ scenario: 'success', env: { FAKE_PROMPT_CAPTURE: capturePath } });
    await send(a, 'first message');

    const first = fs.readFileSync(capturePath, 'utf-8');
    assert.ok(/workspace briefing/.test(first), 'a new session\'s first prompt must carry the workspace briefing');
    assert.ok(/You are agent 'devin-bot' connected to an OpenAgents workspace/.test(first));

    // A fresh peer resuming the SAME session (session/load) must not get a
    // second copy — the briefing is already in the replayed history.
    delete a._peers.thread;
    await send(a, 'follow up message');
    const all = fs.readFileSync(capturePath, 'utf-8');
    assert.equal((all.match(/workspace briefing/g) || []).length, 1, 'the briefing must not be re-sent on session/load');
  });

  it('a second mention in the same channel resumes the same session (session/load)', async () => {
    const a = makeAdapter({ scenario: 'success' });
    await send(a, 'first message');
    const firstSession = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')).thread;

    // Force a fresh process (as if the daemon or the peer had cycled) so the
    // next turn genuinely exercises session/load rather than reusing the
    // live in-memory peer's already-open session.
    delete a._peers.thread;

    await send(a, 'follow up message');
    const secondSession = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')).thread;
    assert.equal(secondSession, firstSession, 'the same channel must resume the same ACP session id');
    // The replay from session/load must not be re-posted as a new answer —
    // only the follow-up turn's own text should appear.
    assert.equal(a._captured.response[a._captured.response.length - 1], 'Hello from Devin.');
  });

  it('a different channel never sees another channel\'s session id (no cross-channel leakage)', async () => {
    const a = makeAdapter({ scenario: 'success' });
    await send(a, 'hello from thread A');
    await a._handleMessage({ content: 'hello from thread B', sessionId: 'other-thread', senderType: 'human', senderName: 'user' });

    const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    assert.notEqual(saved.thread, saved['other-thread']);
    assert.ok(saved.thread && saved['other-thread']);
  });

  it('a rejected session/load falls back to a fresh session and tells the channel', async () => {
    const a = makeAdapter({ scenario: 'success' });
    await send(a, 'first message');
    delete a._peers.thread;

    // Now switch the peer's behavior so the NEXT process rejects session/load.
    a.agentEnv.FAKE_SCENARIO = 'reject_load';
    await send(a, 'follow up after reject');

    assert.ok(a._captured.status.some((s) => /starting a new/i.test(s)), 'the channel must be told a fresh session started');
    const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    assert.match(saved.thread, /^sess-\d+-1$/, 'a fresh session/new was issued after the rejected load');
  });
});

describe('DevinAdapter — permission requests', () => {
  it('answers a session/request_permission and narrates a risky auto-approval', async () => {
    const capturePath = path.join(tmpRoot, `perm-capture-${Date.now()}.json`);
    const a = makeAdapter({ scenario: 'permission', env: { FAKE_PERMISSION_CAPTURE: capturePath, DEVIN_PERMISSION_MODE: 'smart' } });
    await send(a, 'delete the build directory');

    const outcome = JSON.parse(fs.readFileSync(capturePath, 'utf-8'));
    assert.equal(outcome.outcome, 'selected');
    assert.equal(outcome.optionId, 'allow_once');
    assert.ok(a._captured.status.some((s) => /Auto-approved/.test(s)), 'a risky auto-approval must be narrated to the channel');
    assert.equal(a._captured.response[0], 'Done handling permission.');
  });

  it('bypass mode approves without narrating', async () => {
    const capturePath = path.join(tmpRoot, `perm-capture-bypass-${Date.now()}.json`);
    const a = makeAdapter({ scenario: 'permission', env: { FAKE_PERMISSION_CAPTURE: capturePath, DEVIN_PERMISSION_MODE: 'bypass' } });
    await send(a, 'delete the build directory');
    const outcome = JSON.parse(fs.readFileSync(capturePath, 'utf-8'));
    assert.equal(outcome.outcome, 'selected');
    assert.ok(!a._captured.status.some((s) => /Auto-approved/.test(s)));
  });
});

describe('DevinAdapter — cancellation', () => {
  it('cancels a long-running turn, posts a cancellation notice, and the session stays resumable', async () => {
    const a = makeAdapter({ scenario: 'cancel' });
    const turnPromise = send(a, 'do a very long task');
    // Give the fake peer a moment to start the "long task" and register the
    // channel as busy/in-flight before we cancel it.
    await new Promise((r) => setTimeout(r, 300));

    await a._onControlAction('stop', { channel: 'thread' });
    await turnPromise;

    // The partial answer text was buffered (not streamed) when the cancel
    // landed — it must survive into the cancellation notice.
    assert.ok(a._captured.response.some((r) => /Starting a long task/.test(r)), 'partial answer text should appear in the cancellation notice');
    assert.ok(
      a._captured.response.some((r) => /stopped|cancelled|cancel/i.test(r)),
      `expected a cancellation notice, got: ${JSON.stringify(a._captured.response)}`,
    );

    // Resumable: the channel's session id is still on record, and the next
    // mention succeeds (a fresh peer resumes it via session/load).
    const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    assert.ok(saved.thread);
    await send(a, 'are you still there?');
    assert.equal(a._captured.error.length, 0, 'the channel must not be wedged after a cancellation');
  });
});

describe('DevinAdapter — failure recovery', () => {
  it('reports an agent error when the Devin process is killed mid-turn, and the next mention succeeds', async () => {
    const a = makeAdapter({ scenario: 'crash_mid_turn' });
    await send(a, 'this will crash');
    assert.equal(a._captured.error.length, 1);
    assert.ok(/unexpected|crash|exit/i.test(a._captured.error[0]));

    // No daemon restart, no wedged busy state: the very next mention must
    // succeed cleanly (a fresh peer is spawned automatically).
    a.agentEnv.FAKE_SCENARIO = 'success';
    a._captured.error.length = 0;
    await send(a, 'try again');
    assert.equal(a._captured.error.length, 0);
    assert.ok(a._captured.response.includes('Hello from Devin.'));
  });

  it('reports an agent error on a malformed/aborted ACP stream, distinct from a clean turn', async () => {
    const a = makeAdapter({ scenario: 'malformed_stream' });
    await send(a, 'send me garbage');
    assert.equal(a._captured.error.length, 1);
    assert.ok(/malformed|restarted|Devin/i.test(a._captured.error[0]));

    a.agentEnv.FAKE_SCENARIO = 'success';
    a._captured.error.length = 0;
    await send(a, 'try again after garbage');
    assert.equal(a._captured.error.length, 0);
  });

  it('reports a distinct agent error for a plain JSON-RPC protocol error (not auth, not a crash)', async () => {
    const a = makeAdapter({ scenario: 'protocol_error' });
    await send(a, 'trigger a protocol error');
    assert.equal(a._captured.error.length, 1);
    assert.ok(/internal error simulated/.test(a._captured.error[0]));
  });

  it('surfaces a clear, actionable message when Devin reports it is not authenticated', async () => {
    const a = makeAdapter({ scenario: 'auth_required', env: { FAKE_PRE_AUTHED: '0' } });
    await send(a, 'hello');
    assert.equal(a._captured.error.length, 1);
    assert.ok(/devin auth login|WINDSURF_API_KEY/i.test(a._captured.error[0]));
  });
});

describe('DevinAdapter — silence watchdog and auto-recovery', () => {
  it('recovers automatically from a silence wedge via one retry, with no channel error at all', async () => {
    const marker = path.join(tmpRoot, `wedge-marker-${Date.now()}.flag`);
    const a = makeAdapter({ scenario: 'wedge_then_recover', env: { FAKE_WEDGE_MARKER: marker } });
    a._silenceWatchdogMs = 50;
    a._watchdogTickMs = 10;
    await send(a, 'do something that will wedge once');
    assert.equal(a._captured.error.length, 0, 'a successful auto-recovery must not surface any error');
    assert.ok(a._captured.response.includes('Recovered fine.'));
  });

  it('never fires the silence watchdog while a tool call is legitimately in_progress', async () => {
    // Real-world motivation: a gimli-style .NET build ran ~9 minutes with
    // zero ACP traffic (2026-09-19). This silence (150ms) is 3x the test's
    // shortened watchdog threshold (50ms) — it must survive anyway because
    // a tool_call is in_progress the whole time.
    const a = makeAdapter({ scenario: 'long_tool_call_no_wedge' });
    a._silenceWatchdogMs = 50;
    a._watchdogTickMs = 10;
    await send(a, 'run a long build');
    assert.equal(a._captured.error.length, 0);
    assert.ok(a._captured.response.includes('Build finished.'));
  });

  it('gives up after exactly one automatic recovery attempt, does not retry forever', async () => {
    const a = makeAdapter({ scenario: 'always_wedged' });
    a._silenceWatchdogMs = 50;
    a._watchdogTickMs = 10;
    await send(a, 'this will always wedge');
    assert.equal(a._captured.error.length, 1);
    assert.ok(/wedged|activity/i.test(a._captured.error[0]));
  });
});

describe('DevinAdapter — turn hard-timeout config', () => {
  it('defaults to 8 hours with no override', () => {
    const a = makeAdapter();
    assert.equal(a._turnHardTimeoutMs(), 8 * 60 * 60 * 1000);
  });

  it('honors a valid DEVIN_TURN_TIMEOUT_MINUTES override', () => {
    const a = makeAdapter({ env: { DEVIN_TURN_TIMEOUT_MINUTES: '30' } });
    assert.equal(a._turnHardTimeoutMs(), 30 * 60 * 1000);
  });

  it('falls back to the default on an invalid or non-positive override, never throws', () => {
    for (const bad of ['0', '-5', 'not-a-number', '']) {
      const a = makeAdapter({ env: { DEVIN_TURN_TIMEOUT_MINUTES: bad } });
      assert.equal(a._turnHardTimeoutMs(), 8 * 60 * 60 * 1000, `bad value ${JSON.stringify(bad)} should fall back to default`);
    }
  });
});

describe('DevinAdapter — workspace model picker', () => {
  it('respawns an already-running peer when the workspace model picker changes, on a NEW session', async () => {
    const a = makeAdapter({ scenario: 'success' });
    await send(a, 'first message, default model');
    assert.equal(a._peers.thread.spawnModel, null);
    const firstSession = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')).thread;

    a._captured.logs.length = 0;
    a._onControlAction('model.set', { model: 'claude-opus-5' });
    await send(a, 'second message, after picking a model');

    assert.ok(
      a._captured.logs.some((l) => /Model changed to claude-opus-5 for thread — respawning with a new session/.test(l)),
      `expected a respawn log, got: ${JSON.stringify(a._captured.logs)}`,
    );
    assert.equal(a._peers.thread.spawnModel, 'claude-opus-5');
    // A resumed session keeps the model it was created on, so the switch must
    // not session/load the old one.
    const secondSession = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')).thread;
    assert.notEqual(secondSession, firstSession, 'a model change must start a new session, not resume the old one');
    assert.equal(JSON.parse(fs.readFileSync(SESSION_MODELS_FILE, 'utf-8')).thread, 'claude-opus-5');
    assert.ok(a._captured.status.some((s) => /starting a new Devin session/.test(s)), 'the channel is told why its Devin session restarted');
  });

  it('starts a new session when the model changed while no peer was running', async () => {
    const a = makeAdapter({ scenario: 'success' });
    await send(a, 'first message, default model');
    const firstSession = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')).thread;
    assert.equal(JSON.parse(fs.readFileSync(SESSION_MODELS_FILE, 'utf-8')).thread, null);

    // As after a daemon restart: no live peer, and the picker has moved on.
    await a._stopProcess(a._peers.thread.proc);
    delete a._peers.thread;
    a._onControlAction('model.set', { model: 'swe-2-high' });
    await send(a, 'message after the restart');

    const secondSession = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')).thread;
    assert.notEqual(secondSession, firstSession, 'the stored session was created on another model — must not be resumed');
    assert.equal(JSON.parse(fs.readFileSync(SESSION_MODELS_FILE, 'utf-8')).thread, 'swe-2-high');
  });

  it('still resumes a stored session with no recorded model (created before models were recorded)', async () => {
    const a = makeAdapter({ scenario: 'success' });
    await send(a, 'first message');
    const firstSession = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')).thread;
    await a._stopProcess(a._peers.thread.proc);
    delete a._peers.thread;
    delete a._channelSessionModels.thread; // legacy: no entry at all

    await send(a, 'follow up');
    assert.equal(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')).thread, firstSession);
  });

  it('does not respawn a live peer when the picker has not changed', async () => {
    const a = makeAdapter({ scenario: 'success' });
    await send(a, 'first message');
    const firstPeer = a._peers.thread;

    a._captured.logs.length = 0;
    await send(a, 'second message, same model as before');

    assert.ok(!a._captured.logs.some((l) => /respawning/.test(l)), 'no model change — must not respawn');
    assert.equal(a._peers.thread, firstPeer, 'the same peer object should still be in use');
  });
});

describe('DevinAdapter — redaction', () => {
  it('never logs the workspace token or an API key value across a full start-to-ready sequence', async () => {
    const a = makeAdapter({ scenario: 'success', agentEnv: { WINDSURF_API_KEY: 'sk-supersecretvalue1234567890abcdefg' } });
    a.token = 'workspace-token-abc123-should-not-leak-anywhere-visible';
    await send(a, 'hello');
    const everything = JSON.stringify({ ...a._captured });
    assert.ok(!everything.includes('sk-supersecretvalue1234567890abcdefg'), 'API key leaked into a log/status/response');
    assert.ok(!everything.includes('workspace-token-abc123-should-not-leak-anywhere-visible'), 'workspace token leaked');
  });
});

describe('DevinAdapter — live model catalog', () => {
  it('run() fetches the account model list without blocking startup, and _ensurePeer validates against it', async () => {
    const a = makeAdapter({ scenario: 'success' });
    // run() itself joins/polls the (fake) workspace forever, so don't await
    // it — just confirm the fire-and-forget fetch it kicks off completes and
    // populates _availableModels.
    a.client.joinNetwork = async () => ({ session_id: 's1' });
    a.client.getAgents = async () => [];
    a.client.getHeadEventId = async () => 'h1';
    a.client.pollPending = async () => ({ messages: [], cursor: null, composing: false });
    a.client.heartbeat = async () => {};
    a.client.pollControl = async () => [];
    a.client.disconnect = async () => {};
    const runPromise = a.run();
    await new Promise((resolve) => {
      const check = () => (a._availableModels ? resolve() : setTimeout(check, 20));
      check();
    });
    assert.ok(a._availableModels.has('claude-opus-5-medium'));
    assert.ok(a._availableModels.has('opus'));
    assert.ok(a._availableModels.has('claude-sonnet-5'), 'family slug/uid must be included, not just variants');
    assert.ok(a._captured.logs.some((l) => /fetched 2 model families \(2 variants\)/.test(l)));

    a.agentEnv = { ...a.agentEnv, DEVIN_MODEL: 'this-model-does-not-exist' };
    await send(a, 'hello');
    assert.ok(
      a._captured.logs.some((l) => l.includes('configured model "this-model-does-not-exist" isn\'t in this account\'s live catalog')),
      'expected an advisory warning for an unrecognized configured model',
    );

    a.stop();
    await runPromise.catch(() => {});
  });

  it('a fetch failure (not authenticated) leaves _availableModels null and never warns', async () => {
    const a = makeAdapter({ scenario: 'success', env: { FAKE_MODELS_FAIL: '1' } });
    await a._refreshAvailableModels();
    assert.equal(a._availableModels, null);
    assert.ok(a._captured.logs.some((l) => l.includes('could not fetch live model list')));

    a.agentEnv = { ...a.agentEnv, DEVIN_MODEL: 'anything-at-all' };
    await send(a, 'hello');
    assert.ok(
      !a._captured.logs.some((l) => l.includes('isn\'t in this account\'s live catalog')),
      'must not warn when the catalog itself is unknown (null), only when it was fetched and the model is absent',
    );
  });
});
