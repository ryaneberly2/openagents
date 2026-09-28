'use strict';

// The workspace token must not reach chat through the tool-call status echo
// (2026-09-28): the generated skill now carries $OPENAGENTS_WORKSPACE_TOKEN
// instead of the literal, and every echoed command is redacted.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets, workspaceTokenExpr, WORKSPACE_TOKEN_ENV } = require('../src/adapters/utils');
const { buildClaudeSkillMd } = require('../src/adapters/workspace-prompt');

const TOKEN = 'test-workspace-token-not-real-0123456789ab';

describe('redactSecrets', () => {
  it('masks a known literal wherever it appears', () => {
    const out = redactSecrets(`echo ${TOKEN} > /tmp/x`, [TOKEN]);
    assert.ok(!out.includes(TOKEN));
    assert.match(out, /\[REDACTED\]/);
  });

  it('masks the workspace token header and a ?token= query', () => {
    assert.ok(!redactSecrets(`curl -H "X-Workspace-Token: ${TOKEN}" http://h/v1/files`).includes(TOKEN));
    assert.ok(!redactSecrets(`curl "https://q/v1/files/f?token=${TOKEN}"`).includes(TOKEN));
  });

  it('masks sqlcmd / bcp -P passwords and Password= in connection strings', () => {
    assert.ok(!redactSecrets('sqlcmd -S elrond -U sa -P Hunter22 -Q "select 1"').includes('Hunter22'));
    assert.ok(!redactSecrets('bcp t out f -P "pa ss" -c').includes('pa ss'));
    assert.ok(!redactSecrets('Server=x;User=y;Password=Hunter22;').includes('Hunter22'));
  });

  it('leaves ordinary commands alone and ignores short or missing literals', () => {
    assert.equal(redactSecrets('ls -la /workspace', ['', null, 'ab']), 'ls -la /workspace');
  });
});

describe('generated workspace skill', () => {
  it('uses the environment variable, never the token', () => {
    assert.equal(workspaceTokenExpr(false), '$' + WORKSPACE_TOKEN_ENV);
    assert.equal(workspaceTokenExpr(true), '$env:' + WORKSPACE_TOKEN_ENV);
    const md = buildClaudeSkillMd({
      endpoint: 'http://host:8080', workspaceId: 'ws', token: workspaceTokenExpr(false),
      agentName: 'forge', channelName: 'channel-x', disabledModules: new Set(),
    });
    assert.ok(!md.includes(TOKEN));
    assert.ok(md.includes('"X-Workspace-Token: $OPENAGENTS_WORKSPACE_TOKEN"'), 'headers are double-quoted so the shell expands them');
    assert.match(md, /Never paste the token/);
  });
});
