/**
 * Pure helpers for the Devin adapter — Agent Client Protocol (ACP) wire
 * framing, JSON-RPC message builders, session-update interpretation,
 * permission-mode policy, version parsing and redaction.
 *
 * Split out from devin.js so the protocol logic is unit-testable without
 * spawning a real `devin acp` process. Everything here is synchronous and has
 * no side effects.
 *
 * ── The wire format, verified against the real spec (not guessed) ──
 *
 * ACP is JSON-RPC 2.0 over stdio. Messages are newline-delimited JSON: one
 * complete JSON value per line, no embedded literal newlines (a `JSON.stringify`
 * of any value already satisfies this — control characters inside strings are
 * escaped, never emitted raw). This is NOT the LSP Content-Length framing.
 * Verified against https://agentclientprotocol.com (protocol v1, the stable,
 * broadly-deployed schema — see
 * https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)
 * and cross-checked against Devin's own docs
 * (https://docs.devin.ai/cli/reference/commands, `devin acp`: "speaks JSON-RPC
 * over stdin/stdout").
 *
 * Methods WE (the client) call on the agent (`devin acp`):
 *   initialize, authenticate, session/new, session/load, session/prompt
 *   (all requests — expect a response), session/cancel (a NOTIFICATION — no id,
 *   no response; the agent instead resolves the in-flight session/prompt
 *   request with stopReason "cancelled").
 *
 * Methods the AGENT calls on us:
 *   session/update (a notification — streamed progress; see
 *     interpretSessionUpdate), session/request_permission (a request — we MUST
 *     reply with { outcome }).
 *
 * We do not advertise `fs` or `terminal` client capabilities, so a
 * spec-compliant agent will not call `fs/*` or `terminal/*` on us. Devin's own
 * ACP server is a full agent CLI with its own native tool execution (unlike a
 * thin ACP shim that requires the client to proxy file I/O), so this keeps the
 * adapter's server-side surface minimal and honest about what it supports.
 */

'use strict';

const { redactSecrets } = require('./utils');

const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// NDJSON framing
// ---------------------------------------------------------------------------

/**
 * Encode one JSON-RPC message (request, response, or notification) as a
 * single NDJSON line. `JSON.stringify` already escapes any control character
 * that would otherwise break the "one message per line" contract, so no
 * further sanitization is needed.
 */
function encodeMessage(msg) {
  return JSON.stringify(msg) + '\n';
}

/**
 * Incremental NDJSON line decoder for a stdout stream.
 *
 * Buffers partial chunks (a `Buffer`/JSON split across two `data` events is
 * routine with a pipe) and emits one parsed object per complete line via
 * `onMessage`. A line that fails to parse as JSON is reported through
 * `onParseError(rawLine)` and otherwise skipped — one malformed line must not
 * take down a whole conversation, but the caller can count consecutive
 * failures and decide the peer's stream is unrecoverable (see
 * MAX_CONSECUTIVE_PARSE_ERRORS in devin.js).
 *
 * @param {(msg: object) => void} onMessage
 * @param {(rawLine: string, err: Error) => void} [onParseError]
 * @returns {{ push(chunk: string|Buffer): void, flush(): void }}
 */
function createLineDecoder(onMessage, onParseError) {
  let buffer = '';
  const handleLine = (line) => {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      if (onParseError) onParseError(trimmed, e);
      return;
    }
    if (parsed && typeof parsed === 'object') onMessage(parsed);
  };
  return {
    push(chunk) {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) handleLine(line);
    },
    /** Flush a trailing line with no terminating newline (e.g. on process exit). */
    flush() {
      if (buffer) {
        const rest = buffer;
        buffer = '';
        handleLine(rest);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Outgoing message builders (client → agent)
// ---------------------------------------------------------------------------

function buildRequest(id, method, params) {
  return { jsonrpc: '2.0', id, method, params };
}

function buildNotification(method, params) {
  return { jsonrpc: '2.0', method, params };
}

/** `initialize` — first message on every connection. */
function buildInitializeRequest(id, { clientName = 'openagents-workspace', clientVersion = '0.0.0' } = {}) {
  return buildRequest(id, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      // No fs/terminal bridge: Devin's ACP server executes its own tools
      // natively against the working directory it was given. See file header.
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: clientName, title: 'OpenAgents Workspace', version: clientVersion },
  });
}

/** `authenticate` — only sent when the agent reports it needs it. */
function buildAuthenticateRequest(id, methodId) {
  return buildRequest(id, 'authenticate', { methodId });
}

/** `session/new` — mcpServers is REQUIRED by the schema even when empty. */
function buildNewSessionRequest(id, { cwd, mcpServers = [] }) {
  return buildRequest(id, 'session/new', { cwd, mcpServers });
}

/** `session/load` — only sent when the agent advertised `agentCapabilities.loadSession`. */
function buildLoadSessionRequest(id, { sessionId, cwd, mcpServers = [] }) {
  return buildRequest(id, 'session/load', { sessionId, cwd, mcpServers });
}

/** `session/prompt` — a single text content block is all this adapter sends. */
function buildPromptRequest(id, { sessionId, text }) {
  return buildRequest(id, 'session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: String(text == null ? '' : text) }],
  });
}

/** `session/cancel` — a NOTIFICATION (no id, no response expected). */
function buildCancelNotification(sessionId) {
  return buildNotification('session/cancel', { sessionId });
}

/** Our reply to the agent's `session/request_permission` request. */
function buildPermissionResponse(id, outcome) {
  return { jsonrpc: '2.0', id, result: { outcome } };
}

/** A JSON-RPC error response, for a method we do not implement (defense in depth). */
function buildErrorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const ERROR_CODE = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  REQUEST_CANCELLED: -32800,
  AUTH_REQUIRED: -32000,
  RESOURCE_NOT_FOUND: -32002,
};

// ---------------------------------------------------------------------------
// Incoming content / session-update interpretation (agent → client)
// ---------------------------------------------------------------------------

/** Best-effort plain-text rendering of one ACP ContentBlock. */
function contentBlockToText(block) {
  if (!block || typeof block !== 'object') return '';
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    case 'resource_link':
      return block.uri ? `[resource: ${block.uri}]` : '[resource]';
    case 'resource': {
      const r = block.resource;
      if (r && typeof r.text === 'string') return r.text;
      return r && r.uri ? `[resource: ${r.uri}]` : '[resource]';
    }
    default:
      return '';
  }
}

/**
 * Normalize one `session/update` payload's `update` field into a shape the
 * adapter can act on without re-deriving the discriminator logic. Unknown /
 * not-yet-handled variants come back as `{ kind: 'other', sessionUpdate }` so
 * a future protocol addition degrades to "ignored", never a crash.
 */
function interpretSessionUpdate(update) {
  if (!update || typeof update !== 'object') return { kind: 'other', sessionUpdate: null };
  const kind = update.sessionUpdate;
  switch (kind) {
    case 'agent_message_chunk':
      return { kind: 'agent_text', text: contentBlockToText(update.content), messageId: update.messageId || null };
    case 'agent_thought_chunk':
      return { kind: 'agent_thought', text: contentBlockToText(update.content), messageId: update.messageId || null };
    case 'user_message_chunk':
      return { kind: 'user_echo', text: contentBlockToText(update.content), messageId: update.messageId || null };
    case 'tool_call':
      return {
        kind: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.title || update.name || 'tool',
        toolKind: update.kind || 'other',
        status: update.status || 'pending',
      };
    case 'tool_call_update':
      return {
        kind: 'tool_call_update',
        toolCallId: update.toolCallId,
        title: update.title || null,
        toolKind: update.kind || null,
        status: update.status || null,
      };
    case 'plan':
      return {
        kind: 'plan',
        entries: Array.isArray(update.entries)
          ? update.entries.map((e) => ({
              content: String((e && e.content) || ''),
              status: (e && e.status) || 'pending',
              priority: (e && e.priority) || 'medium',
            }))
          : [],
      };
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'usage_update':
      return { kind: 'other', sessionUpdate: kind };
    default:
      return { kind: 'other', sessionUpdate: kind || null };
  }
}

/** One-line status label for a tool_call / tool_call_update, for sendStatus(). */
function toolCallLabel(update) {
  const title = update.title || 'tool';
  const kind = update.toolKind ? ` (${update.toolKind})` : '';
  const status = update.status ? ` — ${update.status}` : '';
  return `${title}${kind}${status}`;
}

/** Render a `plan` update as a short markdown-ish status line. */
function planToStatusText(entries) {
  if (!entries || !entries.length) return 'Plan updated (no entries).';
  const icon = (s) => (s === 'completed' ? '✅' : s === 'in_progress' ? '🔄' : '⬜');
  return 'Plan:\n' + entries.map((e) => `${icon(e.status)} ${e.content}`).join('\n');
}

// ---------------------------------------------------------------------------
// Permission-mode policy
// ---------------------------------------------------------------------------

/**
 * Normalize the operator-configured DEVIN_PERMISSION_MODE into one of four
 * internal policies. Unrecognized/absent values fall back to 'smart' — NOT a
 * bypass mode (see the ticket's explicit "do not silently default to a bypass
 * mode" requirement). 'smart' is deliberately the most conservative usable
 * default: it never remembers a decision (`allow_always`) and always narrates
 * a risky auto-approval to the channel, so an operator watching the channel
 * sees every consequential decision even though nobody had to click anything.
 */
function normalizePermissionMode(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'accept-edits' || v === 'acceptedits') return 'accept-edits';
  if (v === 'dangerous' || v === 'yolo' || v === 'bypass') return 'bypass';
  if (v === 'autonomous') return 'autonomous';
  // 'normal', 'auto', 'smart', '', or anything unrecognized.
  return 'smart';
}

const RISKY_TOOL_KINDS = new Set(['execute', 'delete', 'move']);
const LOW_RISK_TOOL_KINDS = new Set(['read', 'search', 'fetch', 'think']);

function findOption(options, ...kinds) {
  for (const kind of kinds) {
    const found = options.find((o) => o && o.kind === kind);
    if (found) return found;
  }
  return null;
}

/**
 * Decide how to answer a `session/request_permission` request, without
 * blocking on a human — there is nobody attached to this stdio pipe to ask.
 *
 * @param {object} o
 * @param {Array<{optionId:string,name:string,kind:string}>} o.options
 * @param {string} [o.toolKind] the ToolKind of the tool call needing permission
 * @param {string} [o.mode] raw DEVIN_PERMISSION_MODE value
 * @returns {{ option: object, remembered: boolean, notice: string|null }}
 *   `option` is the PermissionOption chosen; `notice`, when non-null, is a
 *   message the caller should post to the channel for transparency.
 */
function decideDevinPermission({ options, toolKind, mode } = {}) {
  const opts = Array.isArray(options) ? options.filter(Boolean) : [];
  const policy = normalizePermissionMode(mode);
  const kind = toolKind || 'other';

  if (!opts.length) {
    return { option: null, remembered: false, notice: 'No permission options were offered — cannot proceed.' };
  }

  const pickAllow = (preferAlways) => {
    if (preferAlways) {
      const always = findOption(opts, 'allow_always');
      if (always) return always;
    }
    const once = findOption(opts, 'allow_once');
    if (once) return once;
    const anyAllow = opts.find((o) => o.kind === 'allow_always');
    if (anyAllow) return anyAllow;
    // No "allow" kind offered at all — nothing to do but take the first option
    // (which, per the schema, is the agent's own suggested default).
    return opts[0];
  };

  if (policy === 'bypass' || policy === 'autonomous') {
    const option = pickAllow(true);
    return { option, remembered: option.kind === 'allow_always', notice: null };
  }

  if (policy === 'accept-edits') {
    if (kind === 'edit' || LOW_RISK_TOOL_KINDS.has(kind)) {
      const option = pickAllow(true);
      return { option, remembered: option.kind === 'allow_always', notice: null };
    }
    const option = pickAllow(false);
    return {
      option,
      remembered: false,
      notice: `Auto-approved a "${kind}" tool call once (permission mode: accept-edits) — this mode auto-approves edits but confirms other actions individually.`,
    };
  }

  // 'smart' (and its alias 'normal'/'auto'): never remembers a decision.
  if (LOW_RISK_TOOL_KINDS.has(kind)) {
    const option = pickAllow(false);
    return { option, remembered: false, notice: null };
  }
  const option = pickAllow(false);
  const riskNote = RISKY_TOOL_KINDS.has(kind) ? ' (a higher-risk operation)' : '';
  return {
    option,
    remembered: false,
    notice: `Auto-approved a "${kind}" tool call once${riskNote} — no one is attached to approve it interactively (permission mode: smart).`,
  };
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

/**
 * Build the argv Devin is spawned with. `acp` is Devin's documented ACP-server
 * subcommand. `--respect-workspace-trust false` is Devin's own documented
 * global flag for scripts/CI to skip the interactive workspace-trust prompt
 * (https://docs.devin.ai/cli/reference/commands) — passed here as a GLOBAL
 * flag ahead of the subcommand, which is the conventional placement for a
 * CLI's global flags; this placement is an inference from the documented flag
 * list (the docs describe the flag but not its exact position relative to
 * `acp`), not something verified against a running binary. `--sandbox` is
 * documented by the ticket as required for `autonomous` permission mode;
 * passed only in that mode.
 *
 * @param {object} o
 * @param {string} [o.model]
 * @param {boolean} [o.autonomous]
 * @returns {string[]} args to pass AFTER the resolved `devin` binary path
 */
function buildDevinAcpArgs({ model, autonomous = false } = {}) {
  const args = ['--respect-workspace-trust', 'false'];
  if (autonomous) args.push('--sandbox');
  args.push('acp');
  const m = String(model || '').trim();
  if (m) args.push('--model', m);
  return args;
}

// ---------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------

/** Parse a dotted version out of `devin version` / `devin --version` output. */
function parseDevinVersion(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)(?:[-.][0-9A-Za-z.]+)?/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

// ---------------------------------------------------------------------------
// Redaction (re-exported for callers that only need devin-acp.js)
// ---------------------------------------------------------------------------

/** Redact a raw JSON-RPC frame before it is logged, truncated to a sane length. */
function redactFrameForLog(msg, maxLen = 500) {
  let s;
  try {
    s = typeof msg === 'string' ? msg : JSON.stringify(msg);
  } catch {
    s = String(msg);
  }
  s = redactSecrets(s);
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

module.exports = {
  PROTOCOL_VERSION,
  ERROR_CODE,
  encodeMessage,
  createLineDecoder,
  buildRequest,
  buildNotification,
  buildInitializeRequest,
  buildAuthenticateRequest,
  buildNewSessionRequest,
  buildLoadSessionRequest,
  buildPromptRequest,
  buildCancelNotification,
  buildPermissionResponse,
  buildErrorResponse,
  contentBlockToText,
  interpretSessionUpdate,
  toolCallLabel,
  planToStatusText,
  normalizePermissionMode,
  decideDevinPermission,
  buildDevinAcpArgs,
  parseDevinVersion,
  redactFrameForLog,
};
