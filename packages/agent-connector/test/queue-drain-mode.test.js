'use strict';

/**
 * Per-channel queue drain modes (OPENAGENTS_QUEUE_DRAIN) — how a backlog that
 * piled up while a channel was busy gets fed to _handleMessage once it's
 * free again.
 *
 *   'none'           (default) — one queued message per turn, in order.
 *   'combine-sender' — every queued message from the same sender merged
 *                     into one turn; distinct senders still get separate
 *                     turns.
 *   'combine-all'    — the whole backlog, every sender, becomes one turn.
 *
 * Run: node --test test/queue-drain-mode.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const BaseAdapter = require('../src/adapters/base');

function makeAdapter(agentEnv) {
  const handled = [];
  const a = new BaseAdapter({
    workspaceId: 'w',
    channelName: 'general',
    token: 't',
    agentName: 'a',
    endpoint: 'http://127.0.0.1:0',
    agentEnv: agentEnv || {},
  });
  a._log = () => {};
  a.sendStatus = async () => {};
  a.sendError = async () => {};
  a._prefetchPinnedContext = async () => {};
  a._handleMessage = async (msg) => { handled.push(msg); };
  return { a, handled };
}

const msg = (senderName, content, queueId) => ({ senderName, content, sessionId: 'general', _queueId: queueId });

describe('_queueDrainMode', () => {
  it('defaults to "none" when unset or unrecognised', () => {
    assert.equal(makeAdapter({}).a._queueDrainMode(), 'none');
    assert.equal(makeAdapter({ OPENAGENTS_QUEUE_DRAIN: 'bogus' }).a._queueDrainMode(), 'none');
  });
  it('recognises combine-sender and combine-all, case/space-insensitive', () => {
    assert.equal(makeAdapter({ OPENAGENTS_QUEUE_DRAIN: 'combine-sender' }).a._queueDrainMode(), 'combine-sender');
    assert.equal(makeAdapter({ OPENAGENTS_QUEUE_DRAIN: ' Combine-All ' }).a._queueDrainMode(), 'combine-all');
  });
});

describe('mode "none" — unchanged behaviour', () => {
  it('drains one queued message per _handleMessage call, in order', async () => {
    const { a, handled } = makeAdapter({});
    a._channelQueues.general = [msg('bob', 'first', 'q1'), msg('bob', 'second', 'q2')];
    while (true) {
      const batch = a._takeDrainBatch('general', a._queueDrainMode());
      if (batch.length === 0) break;
      await a._handleMessage(batch.length > 1 ? a._combineQueuedMessages(batch) : batch[0]);
    }
    assert.equal(handled.length, 2);
    assert.equal(handled[0].content, 'first');
    assert.equal(handled[1].content, 'second');
  });
});

describe('mode "combine-sender"', () => {
  it('merges every message from one sender into a single turn', async () => {
    const { a } = makeAdapter({ OPENAGENTS_QUEUE_DRAIN: 'combine-sender' });
    a._channelQueues.general = [msg('bob', 'one', 'q1'), msg('bob', 'two', 'q2')];
    const batch = a._takeDrainBatch('general', 'combine-sender');
    assert.equal(batch.length, 2);
    assert.deepEqual(a._channelQueues.general, []);
    const combined = a._combineQueuedMessages(batch);
    assert.match(combined.content, /You were sent 2 messages/);
    assert.match(combined.content, /1\) \[bob\]: one/);
    assert.match(combined.content, /2\) \[bob\]: two/);
    assert.equal(combined._queueId, 'q1,q2');
  });

  it('leaves a different sender for the next batch, oldest-sender-first', async () => {
    const { a, handled } = makeAdapter({ OPENAGENTS_QUEUE_DRAIN: 'combine-sender' });
    a._channelQueues.general = [msg('bob', 'b1', 'q1'), msg('alice', 'a1', 'q2'), msg('bob', 'b2', 'q3')];
    while (true) {
      const batch = a._takeDrainBatch('general', 'combine-sender');
      if (batch.length === 0) break;
      await a._handleMessage(batch.length > 1 ? a._combineQueuedMessages(batch) : batch[0]);
    }
    // First batch is every 'bob' message in the queue (b1 AND b2, not just the
    // adjacent one) — combine-sender groups by sender across the whole
    // backlog, not just consecutive runs.
    assert.equal(handled.length, 2);
    assert.match(handled[0].content, /1\) \[bob\]: b1/);
    assert.match(handled[0].content, /2\) \[bob\]: b2/);
    assert.equal(handled[1].senderName, 'alice');
    assert.equal(handled[1].content, 'a1');
  });

  it('a lone message from a sender is passed through unmerged (batch of 1)', () => {
    const { a } = makeAdapter({ OPENAGENTS_QUEUE_DRAIN: 'combine-sender' });
    a._channelQueues.general = [msg('bob', 'solo', 'q1')];
    const batch = a._takeDrainBatch('general', 'combine-sender');
    assert.equal(batch.length, 1);
    assert.equal(batch[0].content, 'solo');
  });
});

describe('mode "combine-all"', () => {
  it('merges the entire backlog, every sender, into one turn', async () => {
    const { a, handled } = makeAdapter({ OPENAGENTS_QUEUE_DRAIN: 'combine-all' });
    a._channelQueues.general = [msg('bob', 'b1', 'q1'), msg('alice', 'a1', 'q2'), msg('bob', 'b2', 'q3')];
    while (true) {
      const batch = a._takeDrainBatch('general', 'combine-all');
      if (batch.length === 0) break;
      await a._handleMessage(batch.length > 1 ? a._combineQueuedMessages(batch) : batch[0]);
    }
    assert.equal(handled.length, 1);
    assert.match(handled[0].content, /You were sent 3 messages/);
    assert.match(handled[0].content, /1\) \[bob\]: b1/);
    assert.match(handled[0].content, /2\) \[alice\]: a1/);
    assert.match(handled[0].content, /3\) \[bob\]: b2/);
  });

  it('keeps attachments from every message in the batch', () => {
    const { a } = makeAdapter({ OPENAGENTS_QUEUE_DRAIN: 'combine-all' });
    const m1 = msg('bob', 'one', 'q1'); m1.attachments = ['a.png'];
    const m2 = msg('alice', 'two', 'q2'); m2.attachments = ['b.png'];
    a._channelQueues.general = [m1, m2];
    const batch = a._takeDrainBatch('general', 'combine-all');
    const combined = a._combineQueuedMessages(batch);
    assert.deepEqual(combined.attachments, ['a.png', 'b.png']);
  });

  it('adopts the newest message\'s identity fields (sessionId etc.)', () => {
    const { a } = makeAdapter({ OPENAGENTS_QUEUE_DRAIN: 'combine-all' });
    const m1 = { senderName: 'bob', content: 'one', sessionId: 'chan-1', _queueId: 'q1' };
    const m2 = { senderName: 'alice', content: 'two', sessionId: 'chan-1', _queueId: 'q2' };
    a._channelQueues.general = [m1, m2];
    const batch = a._takeDrainBatch('general', 'combine-all');
    const combined = a._combineQueuedMessages(batch);
    assert.equal(combined.senderName, 'alice'); // newest (last-queued) wins identity
  });
});

describe('_dispatchMessage / _channelWorker end-to-end, mode default vs combine-all', () => {
  it('"none": a burst while busy produces one _handleMessage call per message', async () => {
    const { a, handled } = makeAdapter({});
    let resolveFirst;
    a._handleMessage = async (m) => {
      handled.push(m);
      if (handled.length === 1) await new Promise((r) => { resolveFirst = r; });
    };
    await a._dispatchMessage(msg('bob', 'trigger'));
    await a._dispatchMessage(msg('bob', 'queued-1'));
    await a._dispatchMessage(msg('bob', 'queued-2'));
    resolveFirst();
    // Let the channel worker's drain loop run to completion.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(handled.length, 3);
  });

  it('"combine-all": the same burst produces the trigger turn + ONE combined drain turn', async () => {
    const { a, handled } = makeAdapter({ OPENAGENTS_QUEUE_DRAIN: 'combine-all' });
    let resolveFirst;
    a._handleMessage = async (m) => {
      handled.push(m);
      if (handled.length === 1) await new Promise((r) => { resolveFirst = r; });
    };
    await a._dispatchMessage(msg('bob', 'trigger'));
    await a._dispatchMessage(msg('bob', 'queued-1'));
    await a._dispatchMessage(msg('alice', 'queued-2'));
    resolveFirst();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(handled.length, 2); // trigger, then one combined turn for both queued messages
    assert.match(handled[1].content, /You were sent 2 messages/);
  });
});
