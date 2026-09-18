'use strict';

/**
 * Gated real-binary end-to-end test for DevinAdapter.
 *
 * Skipped entirely unless DEVIN_E2E=1 AND a real `devin` binary can be
 * resolved on this machine — never runs in the default `npm test` suite, and
 * never requires network or credentials to be PRESENT for `npm test` to stay
 * green (it simply reports itself skipped when they aren't).
 *
 * What it proves that the fake-ACP-peer suite (devin.test.js) cannot: that a
 * REAL `devin acp` process actually speaks the protocol this adapter expects,
 * end to end, in a real (scratch) working directory. Requires the operator to
 * have already run `devin auth login` (or exported WINDSURF_API_KEY/
 * DEVIN_API_KEY) — this test does not attempt to sign in.
 *
 * Run it explicitly with:
 *   DEVIN_E2E=1 node --test test/devin-e2e.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DevinAdapter = require('../src/adapters/devin');

const E2E_ENABLED = process.env.DEVIN_E2E === '1';

function resolveRealDevinBinary() {
  // Reuses the adapter's own resolution logic, not a second copy of it —
  // this test's whole point is to exercise the REAL detection + spawn path.
  const probe = new DevinAdapter({
    workspaceId: 'e2e', channelName: 'e2e', token: 't', agentName: 'devin-e2e',
    endpoint: 'https://example.invalid', agentEnv: process.env,
  });
  return probe._findDevinBinary();
}

describe('DevinAdapter — real binary end-to-end (gated)', { skip: !E2E_ENABLED && 'set DEVIN_E2E=1 to run against a real, authenticated devin binary' }, () => {
  it('runs one real turn in a scratch repo and edits a file under the working directory', async (t) => {
    const bin = resolveRealDevinBinary();
    if (!bin) {
      t.skip('no real `devin` binary could be resolved on this machine');
      return;
    }

    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-devin-e2e-'));
    try {
      require('child_process').execSync('git init', { cwd: scratchDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(scratchDir, 'NOTES.md'), '# scratch\n');
      require('child_process').execSync('git add -A && git -c user.email=e2e@example.com -c user.name=e2e commit -m init', { cwd: scratchDir, stdio: 'ignore' });

      const captured = { response: [], error: [], status: [], thinking: [] };
      const a = new DevinAdapter({
        workspaceId: 'e2e-ws', channelName: 'e2e-channel', token: 'e2e-token',
        agentName: 'devin-e2e', endpoint: 'https://example.invalid',
        agentEnv: process.env, workingDir: scratchDir,
      });
      a.sendThinking = async (_c, t2) => { captured.thinking.push(t2); };
      a.sendStatus = async (_c, t2) => { captured.status.push(t2); };
      a.sendResponse = async (_c, t2) => { captured.response.push(t2); };
      a.sendError = async (_c, t2) => { captured.error.push(t2); };
      a.client = {
        getSession: async () => ({ title: 'e2e', titleManuallySet: true, resumeFrom: null }),
        updateSession: async () => ({}),
      };

      try {
        await a._handleMessage({
          content: 'Append a line saying "hello from devin e2e" to NOTES.md and save it. Do not do anything else.',
          sessionId: 'e2e-channel', senderType: 'human', senderName: 'e2e',
        });
      } finally {
        try { await a.stop(); } catch {}
      }

      assert.equal(captured.error.length, 0, `expected no adapter error, got: ${JSON.stringify(captured.error)}`);
      assert.ok(captured.response.length > 0, 'expected a final answer');

      const status = require('child_process').execSync('git status --porcelain', { cwd: scratchDir, encoding: 'utf-8' });
      assert.ok(status.trim().length > 0, 'expected a file change under the working directory (git status must show one)');
    } finally {
      try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch {}
    }
  });
});
