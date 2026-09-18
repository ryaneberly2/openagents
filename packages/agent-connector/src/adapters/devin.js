/**
 * Devin CLI adapter for OpenAgents workspace — Agent Client Protocol (ACP).
 *
 * Unlike every other adapter here, which spawns one CLI invocation PER TURN,
 * Devin's headless interface is a long-lived stdio JSON-RPC peer: `devin acp`
 * stays running for the life of a channel's conversation, and turns are
 * `session/prompt` requests sent to the SAME process. See devin-acp.js for the
 * wire-format details and citations; this file owns the process lifecycle,
 * the JSON-RPC request/response bookkeeping, and the mapping from ACP session
 * updates to this codebase's `sendThinking` / `sendStatus` / `sendResponse`
 * streamed-progress contract.
 *
 * One `devin acp` PROCESS per channel (mirrors the "one CLI invocation" model
 * every other adapter uses, just persistent instead of per-turn) — ACP's
 * `session/new` could in principle multiplex several sessions over one
 * process, but a process boundary per channel is what gives us a clean,
 * independent failure domain: a crash or a hung turn in one channel can never
 * wedge another, and killing one channel's process (stop/restart/crash
 * recovery) never touches a sibling channel's conversation.
 *
 * Session continuity: `~/.openagents/sessions/<workspaceId>_<agentName>_devin.json`
 * maps channel → Devin ACP session id, following the exact `_loadSessions` /
 * `_saveSessions` pattern cursor.js and claude.js use. A follow-up message in
 * the same channel resumes that session via `session/load`; a session the
 * agent rejects (expired, unknown, `loadSession` unsupported) falls back to a
 * fresh `session/new`, and the channel is told so explicitly.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
// spawn() here is the WSL bridge from ../wsl: same signature as
// child_process.spawn, and a straight pass-through unless the resolved CLI
// lives on the other side of the Windows/WSL boundary.
const { spawn } = require('../wsl');

const BaseAdapter = require('./base');
const { formatAttachmentsForPrompt, SESSION_DEFAULT_RE, generateSessionTitle, redactSecrets } = require('./utils');
const { buildDevinSystemPrompt } = require('./workspace-prompt');
const { defaultAgentWorkdir, whichBinary, whereBinary, resolveBinaryInKnownDirs } = require('../paths');
const { REASON, classifyAcpAuthError } = require('./health-status');
const acp = require('./devin-acp');

const IS_WINDOWS = process.platform === 'win32';

// No activity (no session/update notification) for this long during an
// in-flight turn gets one "still working..." nudge, so a long agentic turn
// never reads as a hang in the channel. Not a cancellation trigger by itself.
const IDLE_NOTICE_MS = 45 * 1000;
// A turn with truly no activity for this long is almost certainly wedged
// (peer stopped responding without exiting) — cut it loose rather than hold
// the channel busy forever.
const TURN_HARD_TIMEOUT_MS = 45 * 60 * 1000;
// How long we wait for the `initialize` handshake before giving up on a
// freshly-spawned peer.
const INIT_TIMEOUT_MS = 20 * 1000;
const SESSION_SETUP_TIMEOUT_MS = 30 * 1000;
// Bounded wait after sending `session/cancel` before we give up and kill the
// process tree outright (required: "cancellation ... bounded timeout").
const CANCEL_GRACE_MS = 8 * 1000;
// Consecutive unparseable lines on stdout before the stream is treated as
// broken beyond repair (a genuinely malformed/aborted ACP stream, distinct
// from a clean process exit).
const MAX_CONSECUTIVE_PARSE_ERRORS = 5;

/**
 * One JSON-RPC peer over a `devin acp` child process's stdio.
 *
 * Deliberately NOT exported / not in devin-acp.js: this is the stateful glue
 * (a real child process, real pending-request bookkeeping) around the pure
 * message builders and parsers that DO live there. Kept small on purpose —
 * everything with actual decision logic (framing, permission policy, update
 * interpretation) is in devin-acp.js and unit-tested without a process at all.
 */
class AcpPeer {
  constructor({ proc, log }) {
    this.proc = proc;
    this._log = log || (() => {});
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject }
    this._parseErrorStreak = 0;
    this.initialized = false;
    this.agentCapabilities = null;
    this.authMethods = [];
    this.sessionId = null;
    this.dead = false;
    this.stderrTail = '';
    /** Set by devin.js per in-flight turn; read by the notification handler. */
    this.currentTurn = null;
    /** Handler devin.js installs for `session/request_permission`. */
    this.onPermissionRequest = null;
    /** Handler devin.js installs for every `session/update`. */
    this.onSessionUpdate = null;
    /**
     * onSessionUpdate is async (it awaits sendThinking/sendStatus/etc. per
     * update) but _onMessage is called synchronously, once per parsed line,
     * from the decoder — several session/update notifications arriving in
     * one stdout chunk (a fast burst of thought/text deltas is the common
     * case) would otherwise fire off overlapping un-awaited calls, and their
     * network round-trips can then resolve out of order, posting the
     * fragments to the channel scrambled relative to how Devin emitted them.
     * Chaining onto this promise instead serializes them: each update's
     * handler fully completes before the next one starts, regardless of how
     * many arrived in the same tick.
     */
    this._updateChain = Promise.resolve();

    this._decoder = acp.createLineDecoder(
      (msg) => this._onMessage(msg),
      (rawLine) => {
        this._parseErrorStreak++;
        this._log(`Unparseable ACP line (${this._parseErrorStreak}/${MAX_CONSECUTIVE_PARSE_ERRORS}): ${acp.redactFrameForLog(rawLine, 200)}`);
        if (this._parseErrorStreak >= MAX_CONSECUTIVE_PARSE_ERRORS) {
          this._failAllPending(new Error('Devin ACP stream is malformed (too many unparseable lines in a row) — the process will be restarted.'));
        }
      },
    );

    proc.stdout.on('data', (chunk) => this._decoder.push(chunk));
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        this.stderrTail = (this.stderrTail + chunk.toString('utf-8')).slice(-4000);
      });
    }
    proc.on('exit', (code, signal) => {
      this.dead = true;
      this._decoder.flush();
      this._failAllPending(new Error(
        `Devin ACP process exited unexpectedly (code=${code == null ? 'null' : code}, signal=${signal || 'none'})`
          + (this.stderrTail.trim() ? `: ${redactSecrets(this.stderrTail.trim().split('\n').slice(-3).join(' / '))}` : ''),
      ));
    });
  }

  _onMessage(msg) {
    this._parseErrorStreak = 0;
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      // A response to one of OUR requests.
      const pending = this._pending.get(msg.id);
      if (!pending) return; // late/duplicate response — nothing to resolve
      this._pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || 'ACP error');
        err.acpCode = msg.error.code;
        err.acpData = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'session/update') {
      if (typeof this.onSessionUpdate === 'function') {
        const handler = this.onSessionUpdate;
        const params = msg.params;
        this._updateChain = this._updateChain
          .then(() => handler(params))
          .catch((e) => { this._log(`session/update handler threw: ${e.message}`); });
      }
      return;
    }
    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      if (typeof this.onPermissionRequest === 'function') {
        Promise.resolve(this.onPermissionRequest(msg.params))
          .then((outcome) => this._send(acp.buildPermissionResponse(msg.id, outcome)))
          .catch((e) => {
            this._log(`permission handler threw: ${e.message}`);
            this._send(acp.buildPermissionResponse(msg.id, { outcome: 'cancelled' }));
          });
      } else {
        this._send(acp.buildPermissionResponse(msg.id, { outcome: 'cancelled' }));
      }
      return;
    }
    // fs/* or terminal/* would land here — we never advertise those client
    // capabilities, so a spec-compliant peer will not call them, but answer
    // defensively rather than leaving a well-behaved peer hanging on a reply.
    if (msg.id !== undefined && msg.method) {
      this._send(acp.buildErrorResponse(msg.id, acp.ERROR_CODE.METHOD_NOT_FOUND, `Method not supported by this client: ${msg.method}`));
    }
    // Notifications we don't recognize are silently ignored.
  }

  _send(obj) {
    if (this.dead) return;
    try {
      this.proc.stdin.write(acp.encodeMessage(obj));
    } catch (e) {
      this._log(`Failed to write to Devin ACP process: ${e.message}`);
    }
  }

  _failAllPending(err) {
    for (const { reject } of this._pending.values()) {
      try { reject(err); } catch {}
    }
    this._pending.clear();
  }

  /** Send a JSON-RPC request and return a promise for its result. */
  request(builder, timeoutMs) {
    const id = this._nextId++;
    const msg = builder(id);
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = (fn, val) => {
        if (timer) clearTimeout(timer);
        this._pending.delete(id);
        fn(val);
      };
      this._pending.set(id, {
        resolve: (v) => done(resolve, v),
        reject: (e) => done(reject, e),
      });
      if (timeoutMs) {
        timer = setTimeout(() => {
          this._pending.delete(id);
          reject(new Error('Devin ACP request timed out'));
        }, timeoutMs);
      }
      this._send(msg);
    });
  }

  /** Send a notification (no response expected). */
  notify(obj) {
    this._send(obj);
  }
}

class DevinAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.disabledModules = opts.disabledModules || new Set();
    this._channelSessions = {}; // channel -> devin ACP session id
    this._peers = {}; // channel -> AcpPeer
    this._stoppingChannels = new Set();
    this._sessionsFile = path.join(
      os.homedir(), '.openagents', 'sessions',
      `${this.workspaceId}_${this.agentName}_devin.json`,
    );
    this._loadSessions();
    this._devinBin = null;
    // Populated best-effort by _refreshAvailableModels() (see run()); null
    // until that resolves (or forever, if it never can — e.g. not yet
    // authenticated), meaning "unknown, don't warn" everywhere it's read.
    this._availableModels = null;
    this._warnedUnknownModels = new Set();
    // Opt into the base class's per-message pinned-context prefetch so the
    // session briefing can embed the channel's decision log + glossary.
    this._usesPinnedContext = true;
  }

  /**
   * Kick off the live model-catalog fetch CONCURRENTLY with join/skill-sync/
   * poll-loop startup (base.js's run()) rather than blocking any of it — an
   * account lookup that's slow, or fails outright because auth hasn't
   * happened yet, must never delay this agent coming online.
   */
  async run() {
    this._refreshAvailableModels().catch(() => {});
    return super.run();
  }

  /**
   * Best-effort live lookup of this account's real model catalog
   * (`devin models list --format json`), so a configured `DEVIN_MODEL` / the
   * workspace's model picker can be checked against reality instead of only
   * the small, hand-curated, necessarily-stale list baked into
   * registry.json's `models` (Devin's actual catalog is account/plan-specific
   * and has 40+ families). Never throws — an unauthenticated account, a
   * network hiccup, or a `devin` version with a different output shape all
   * just leave `_availableModels` null, and every reader treats null as
   * "unknown, don't warn" rather than "empty, warn about everything."
   *
   * Uses the ASYNC child_process API (execFile, not execFileSync)
   * deliberately: this call hits Devin's own API over the network (see
   * `devin auth status`'s "API server" field) and can take a real amount of
   * time. execFileSync would block this whole process's event loop for that
   * entire duration — including every other channel's in-flight ACP turn —
   * which is exactly the "never blocks startup" guarantee run() promises.
   */
  async _refreshAvailableModels() {
    const bin = this._findDevinBinary();
    if (!bin) return;
    // Same test-double handling as _ensurePeer's spawn: a `.js`/`.mjs`
    // resolution (devin.test.js's fake binary) needs to run through node.
    const execBin = /\.(m?js)$/i.test(bin) ? process.execPath : bin;
    const execArgs = /\.(m?js)$/i.test(bin)
      ? [bin, 'models', 'list', '--format', 'json']
      : ['models', 'list', '--format', 'json'];
    try {
      const { stdout: raw } = await execFileAsync(execBin, execArgs, {
        encoding: 'utf-8',
        timeout: 15000,
        windowsHide: true,
        env: { ...(this.agentEnv || process.env) },
      });
      const parsed = JSON.parse(raw);
      const { ids, families } = acp.flattenModelsCatalog(parsed);
      this._availableModels = ids;
      const variantTotal = families.reduce((n, f) => n + f.variantCount, 0);
      this._log(`Devin: fetched ${families.length} model families (${variantTotal} variants) for this account`);
    } catch (e) {
      // Expected, non-fatal states: not signed in yet, no network, a `devin`
      // version whose JSON shape changed. The loud, actionable "not signed
      // in" message already comes from the readiness/auth path — this stays
      // quiet and simply leaves model validation off.
      this._log(`Devin: could not fetch live model list (${e.message}) — model validation stays advisory-only`);
    }
  }

  /**
   * Warn (once per distinct value) when a configured model isn't in the live
   * catalog. Advisory only: Devin's own `--model` does fuzzy matching, so a
   * value absent from this fetch may still resolve — this exists to catch a
   * plain typo, not to gatekeep.
   */
  _checkConfiguredModel(model) {
    if (!model || !this._availableModels) return;
    const key = String(model).toLowerCase();
    if (this._availableModels.has(key) || this._warnedUnknownModels.has(key)) return;
    this._warnedUnknownModels.add(key);
    this._log(`Devin: configured model "${model}" isn't in this account's live catalog — Devin's own fuzzy matching may still resolve it, but double-check for a typo (see \`devin models list\`)`);
  }

  // ------------------------------------------------------------------
  // Session persistence — copies cursor.js's _loadSessions/_saveSessions
  // pattern exactly (see packages/agent-connector/CLAUDE.md).
  // ------------------------------------------------------------------

  _loadSessions() {
    try {
      if (fs.existsSync(this._sessionsFile)) {
        const data = JSON.parse(fs.readFileSync(this._sessionsFile, 'utf-8'));
        if (data && typeof data === 'object') {
          Object.assign(this._channelSessions, data);
          this._log(`Loaded ${Object.keys(data).length} session(s)`);
        }
      }
    } catch {
      this._log('Could not load sessions file, starting fresh');
    }
  }

  _saveSessions() {
    try {
      const dir = path.dirname(this._sessionsFile);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._sessionsFile, JSON.stringify(this._channelSessions));
    } catch {}
  }

  // ------------------------------------------------------------------
  // Binary resolution
  // ------------------------------------------------------------------

  /**
   * Find the real `devin` binary.
   *
   * Verified against Devin's OWN installers (not guessed):
   *   - macOS/Linux (`curl -fsSL https://cli.devin.ai/install.sh | bash`)
   *     symlinks `~/.local/bin/devin` → the real binary under
   *     `$XDG_DATA_HOME/devin/cli/_versions/<version>/bin/devin`
   *     (XDG_DATA_HOME defaults to `~/.local/share`).
   *   - Windows (`irm https://static.devin.ai/cli/setup.ps1 | iex`) installs to
   *     `%LOCALAPPDATA%\devin\cli\bin\devin.exe` and edits the user PATH
   *     registry key — which an already-running daemon never sees without a
   *     restart, the same staleness Cursor/Amp/Hermes hit (see paths.js).
   *   - Homebrew cask (`brew install --cask devin-cli`) lands in the normal
   *     Homebrew bin dirs, already covered by getKnownBinDirs().
   */
  _findDevinBinary() {
    if (this._devinBin && fs.existsSync(this._devinBin)) return this._devinBin;
    const home = os.homedir();
    const ext = IS_WINDOWS ? '.exe' : '';
    const candidates = [];

    if (IS_WINDOWS) {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      candidates.push(path.join(localAppData, 'devin', 'cli', 'bin', `devin${ext}`));
    } else {
      candidates.push(path.join(home, '.local', 'bin', 'devin'));
      const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
      candidates.push(path.join(xdgData, 'devin', 'cli', '_versions', 'current', 'bin', 'devin'));
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) { this._devinBin = c; return c; }
    }

    const viaWhere = whereBinary('devin');
    if (viaWhere) { this._devinBin = viaWhere; return viaWhere; }

    const viaKnownDirs = resolveBinaryInKnownDirs('devin', 'devin');
    if (viaKnownDirs) { this._devinBin = viaKnownDirs; return viaKnownDirs; }

    const viaWhich = whichBinary('devin');
    if (viaWhich) { this._devinBin = viaWhich; return viaWhich; }

    return null;
  }

  /**
   * Preflight gate (run by the daemon before join). Devin needs a resolvable
   * CLI binary to do anything useful, so when none can be found we surface a
   * precise 'runtime_missing' reason and skip the workspace join entirely —
   * matching the pattern in amp.js/deepseek.js/pi.js/openworker.js.
   */
  preflight() {
    const bin = this._findDevinBinary();
    if (!bin) {
      const hint = IS_WINDOWS
        ? 'irm https://static.devin.ai/cli/setup.ps1 | iex'
        : 'curl -fsSL https://cli.devin.ai/install.sh | bash';
      return {
        ok: false,
        reason: REASON.RUNTIME_MISSING,
        message: `Devin CLI not found — install with: ${hint}`,
      };
    }
    this._log(`Devin CLI resolved: ${bin}`);
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Permission mode / model
  // ------------------------------------------------------------------

  _permissionMode() {
    return (this.agentEnv || process.env).DEVIN_PERMISSION_MODE || 'smart';
  }

  // ------------------------------------------------------------------
  // Workspace MCP server wiring (best-effort — Devin gets the same
  // workspace_* tools every other MCP-mode adapter gets, via ACP's native
  // `mcpServers` session field rather than a CLI --mcp-config flag).
  // ------------------------------------------------------------------

  _resolveWorkspaceMcpServer(channelName) {
    try {
      const home = os.homedir();
      const mcpArgs = [
        'mcp-server',
        '--workspace-id', this.workspaceId,
        '--channel-name', channelName,
        '--agent-name', this.agentName,
        '--endpoint', this.endpoint,
      ];
      if (this.disabledModules.has('files')) mcpArgs.push('--disable-files');
      if (this.disabledModules.has('browser')) mcpArgs.push('--disable-browser');
      if (this.disabledModules.has('knowledge')) mcpArgs.push('--disable-knowledge');

      let mcpCommand = null;
      let mcpFinalArgs = mcpArgs;
      const siblingBin = path.resolve(__dirname, '..', '..', 'bin', 'agent-connector.js');
      const nodeBin = fs.existsSync(path.join(home, '.openagents', 'nodejs', IS_WINDOWS ? 'node.exe' : 'node'))
        ? path.join(home, '.openagents', 'nodejs', IS_WINDOWS ? 'node.exe' : 'node')
        : process.execPath;
      if (fs.existsSync(siblingBin)) {
        mcpCommand = nodeBin;
        mcpFinalArgs = [siblingBin, ...mcpArgs];
      } else {
        const oaExt = IS_WINDOWS ? '.cmd' : '';
        const runtimesRoot = path.join(home, '.openagents', 'runtimes');
        let oaBin = null;
        try {
          for (const d of fs.readdirSync(runtimesRoot, { withFileTypes: true })) {
            if (d.isDirectory()) {
              const candidate = path.join(runtimesRoot, d.name, 'node_modules', '.bin', `openagents${oaExt}`);
              if (fs.existsSync(candidate)) { oaBin = candidate; break; }
            }
          }
        } catch {}
        if (!oaBin) oaBin = whereBinary('openagents');
        if (!oaBin) return null;
        mcpCommand = oaBin;
      }

      return {
        name: 'openagents-workspace',
        command: mcpCommand,
        args: mcpFinalArgs,
        // McpServerStdio.env is an ARRAY of {name, value} (unlike claude.js's
        // --mcp-config JSON, whose env is a plain object) — see devin-acp.js
        // header and the ACP schema's EnvVariable definition.
        env: [{ name: 'OA_WORKSPACE_TOKEN', value: this.token }],
      };
    } catch (e) {
      this._log(`Could not resolve workspace MCP server for Devin (non-fatal, tools disabled this run): ${e.message}`);
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Peer lifecycle
  // ------------------------------------------------------------------

  async _ensurePeer(channel) {
    const existing = this._peers[channel];
    if (existing && !existing.dead) return existing;
    delete this._peers[channel];

    const bin = this._findDevinBinary();
    if (!bin) {
      throw new Error('Devin CLI not found. Install with: curl -fsSL https://cli.devin.ai/install.sh | bash (Windows: irm https://static.devin.ai/cli/setup.ps1 | iex)');
    }

    const mode = acp.normalizePermissionMode(this._permissionMode());
    const configuredModel = this.modelLabel();
    this._checkConfiguredModel(configuredModel);
    const args = acp.buildDevinAcpArgs({ model: configuredModel, autonomous: mode === 'autonomous' });
    const workDir = this.workingDir || defaultAgentWorkdir(this.agentName);
    try { fs.mkdirSync(workDir, { recursive: true }); } catch {}

    const cleanEnv = { ...(this.agentEnv || process.env) };

    // Real Devin installs are always a native binary — but a `.js`/`.mjs`
    // resolution (a test double standing in for `devin`, see devin.test.js's
    // fake ACP peer) has to run through node the same way cursor.js's
    // `_resolveToNodeCmd` handles a JS-entry CLI, or spawn() fails outright on
    // Windows (no shebang support) and is merely lucky to work on POSIX.
    let spawnBin = bin;
    let spawnArgs = args;
    if (/\.(m?js)$/i.test(bin)) {
      spawnArgs = [bin, ...args];
      spawnBin = process.execPath;
    }

    this._log(`Spawning Devin ACP peer for ${channel}: ${spawnBin} ${acp.redactFrameForLog(spawnArgs, 200)}`);

    const proc = spawn(spawnBin, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
      cwd: workDir,
      detached: !IS_WINDOWS,
      windowsHide: true,
    });

    const peer = new AcpPeer({ proc, log: (m) => this._log(`[devin:${channel}] ${m}`) });
    peer.channel = channel;
    peer.onPermissionRequest = (params) => this._onPermissionRequest(channel, params);
    peer.onSessionUpdate = (params) => this._onSessionUpdate(channel, params);
    this._peers[channel] = peer;

    proc.on('error', (e) => {
      peer.dead = true;
      this._log(`Devin process error for ${channel}: ${e.message}`);
    });

    let initResult;
    try {
      initResult = await peer.request(
        (id) => acp.buildInitializeRequest(id, { clientVersion: this._pkgVersion() }),
        INIT_TIMEOUT_MS,
      );
    } catch (e) {
      delete this._peers[channel];
      await this._stopProcess(proc);
      throw new Error(`Devin ACP handshake failed: ${e.message}`);
    }
    peer.initialized = true;
    peer.agentCapabilities = (initResult && initResult.agentCapabilities) || {};
    peer.authMethods = Array.isArray(initResult && initResult.authMethods) ? initResult.authMethods : [];
    return peer;
  }

  _pkgVersion() {
    try {
      // eslint-disable-next-line global-require
      return require(path.join(__dirname, '..', '..', 'package.json')).version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  /**
   * Establish (new) or resume (load) an ACP session for this channel on the
   * given peer. On any load failure — expired session, unknown id, or the
   * agent simply not supporting `session/load` — falls back to a fresh
   * `session/new` and tells the channel, per the acceptance criteria ("a
   * resume that's rejected starts fresh and tells the channel").
   */
  async _ensureSession(channel, peer) {
    if (peer.sessionId) return { sessionId: peer.sessionId, isNew: false };

    const workDir = this.workingDir || defaultAgentWorkdir(this.agentName);
    const mcpServer = this._resolveWorkspaceMcpServer(channel);
    const mcpServers = mcpServer ? [mcpServer] : [];
    const existingSessionId = this._channelSessions[channel];

    if (existingSessionId && peer.agentCapabilities && peer.agentCapabilities.loadSession) {
      try {
        // The agent replays the whole conversation as session/update
        // notifications before responding to session/load — the channel
        // already has that history, so suppress re-posting it.
        peer.currentTurn = { channel, replaying: true, buffer: [], toolCalls: {}, postedAnything: true };
        await peer.request(
          (id) => acp.buildLoadSessionRequest(id, { sessionId: existingSessionId, cwd: workDir, mcpServers }),
          SESSION_SETUP_TIMEOUT_MS,
        );
        peer.currentTurn = null;
        peer.sessionId = existingSessionId;
        return { sessionId: peer.sessionId, isNew: false };
      } catch (e) {
        peer.currentTurn = null;
        this._log(`Session resume rejected for ${channel} (${e.message}) — starting a fresh session`);
        delete this._channelSessions[channel];
        this._saveSessions();
        try { await this.sendStatus(channel, 'Could not resume the previous Devin session — starting a new one.'); } catch {}
      }
    }

    const result = await peer.request(
      (id) => acp.buildNewSessionRequest(id, { cwd: workDir, mcpServers }),
      SESSION_SETUP_TIMEOUT_MS,
    );
    peer.sessionId = result && result.sessionId;
    if (!peer.sessionId) throw new Error('Devin did not return a session id from session/new');
    this._channelSessions[channel] = peer.sessionId;
    this._saveSessions();
    return { sessionId: peer.sessionId, isNew: true };
  }

  /**
   * Attempt the ACP `authenticate` flow once, using an operator-supplied key.
   * Devin's ACP server otherwise reads credentials from `devin auth login`
   * (a real interactive login the operator ran outside this daemon) or
   * WINDSURF_API_KEY in the environment automatically — this method exists
   * for the case where the peer explicitly reports (via the `initialize`
   * response's authMethods, or an auth-required error) that neither is
   * present, and we have something to hand it. There is no browser/OAuth
   * flow attempted here: nothing headless can complete one.
   */
  async _tryAuthenticate(peer) {
    const key = String((this.agentEnv || process.env).WINDSURF_API_KEY || (this.agentEnv || process.env).DEVIN_API_KEY || '').trim();
    if (!key || !peer.authMethods.length) return false;
    // Prefer a method that isn't the "run it in a terminal yourself" escape
    // hatch (`type: 'terminal'` in the schema) — that one is not answerable
    // from here at all.
    const method = peer.authMethods.find((m) => m && m.type !== 'terminal') || null;
    if (!method || !method.id) return false;
    try {
      await peer.request((id) => acp.buildAuthenticateRequest(id, method.id), INIT_TIMEOUT_MS);
      return true;
    } catch (e) {
      this._log(`Devin authenticate attempt failed: ${e.message}`);
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Session-update / permission handlers
  // ------------------------------------------------------------------

  _touchTurn(peer) {
    if (peer.currentTurn) peer.currentTurn.lastActivityAt = Date.now();
  }

  async _onSessionUpdate(channel, params) {
    const peer = this._peers[channel];
    if (!peer || !peer.currentTurn) return;
    this._touchTurn(peer);
    const turn = peer.currentTurn;
    if (turn.replaying) return; // session/load replay — already in the channel's history

    const u = acp.interpretSessionUpdate(params && params.update);
    switch (u.kind) {
      case 'agent_text': {
        if (!u.text) break;
        if (turn.hasToolUseSinceLastText) {
          turn.buffer.length = 0;
          turn.hasToolUseSinceLastText = false;
        }
        // Chunks sharing a messageId are token/word-level deltas of the SAME
        // message and must be concatenated directly (no separator) to
        // reconstruct it; a new messageId (or none) starts a new buffer
        // entry, joined with a blank line from the others at the end. This
        // is exactly what ACP's `messageId` field on ContentChunk exists for
        // — treating every chunk as its own line (as a naive '\n'.join would)
        // would fragment ordinary word-by-word streaming into one line per
        // token.
        const last = turn.buffer[turn.buffer.length - 1];
        if (last && u.messageId && last.messageId === u.messageId) {
          last.text += u.text;
        } else {
          turn.buffer.push({ messageId: u.messageId || null, text: u.text });
        }
        turn.postedAnything = true;
        // Deliberately NOT streamed via sendThinking here, unlike
        // agent_thought below: chunks still in the buffer at turn end ARE the
        // answer, posted once via sendResponse — echoing them live too put
        // every answer in the channel twice (once gray, once as the reply).
        // Chunks a subsequent tool_call reveals to be mid-turn narration are
        // flushed to thinking there instead (see the tool_call case).
        break;
      }
      case 'agent_thought': {
        if (!u.text) break;
        turn.postedAnything = true;
        try { await this.sendThinking(channel, u.text); } catch {}
        break;
      }
      case 'tool_call': {
        // Text buffered before this tool call was mid-turn narration, not the
        // answer — it's discarded from the response buffer below, so flush it
        // to the thinking stream now or it would never be shown at all.
        const narrated = turn.buffer.map((b) => b.text).join('\n\n').trim();
        turn.buffer.length = 0;
        turn.hasToolUseSinceLastText = true;
        if (narrated) {
          try { await this.sendThinking(channel, narrated); } catch {}
        }
        turn.toolCalls[u.toolCallId] = u;
        turn.postedAnything = true;
        try { await this.sendStatus(channel, acp.toolCallLabel(u)); } catch {}
        break;
      }
      case 'tool_call_update': {
        const prior = turn.toolCalls[u.toolCallId] || {};
        const merged = { ...prior, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v != null)) };
        turn.toolCalls[u.toolCallId] = merged;
        turn.postedAnything = true;
        try { await this.sendStatus(channel, acp.toolCallLabel(merged)); } catch {}
        break;
      }
      case 'plan': {
        turn.postedAnything = true;
        try { await this.sendStatus(channel, acp.planToStatusText(u.entries)); } catch {}
        break;
      }
      default:
        break; // available_commands_update / current_mode_update / usage_update / session_info_update
    }
  }

  async _onPermissionRequest(channel, params) {
    const peer = this._peers[channel];
    if (peer) this._touchTurn(peer);
    const toolCall = (params && params.toolCall) || {};
    const decision = acp.decideDevinPermission({
      options: (params && params.options) || [],
      toolKind: toolCall.kind,
      mode: this._permissionMode(),
    });
    if (decision.notice) {
      try { await this.sendStatus(channel, decision.notice); } catch {}
    }
    if (!decision.option) return { outcome: 'cancelled' };
    return { outcome: 'selected', optionId: decision.option.optionId };
  }

  // ------------------------------------------------------------------
  // Cancellation / restart / stop
  // ------------------------------------------------------------------

  async _onControlAction(action, payload) {
    if (action === 'stop') {
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      if (channel && this._peers[channel]) {
        await this._cancelChannel(channel, 'Execution stopped.');
      } else if (!channel) {
        for (const ch of Object.keys(this._peers)) {
          await this._cancelChannel(ch, 'Execution stopped.');
        }
      }
      return;
    }
    if (action === 'restart') {
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      if (channel) {
        if (this._peers[channel]) {
          this._stoppingChannels.add(channel);
          await this._stopProcess(this._peers[channel].proc);
          delete this._peers[channel];
        }
        delete this._channelQueues[channel];
        delete this._channelSessions[channel];
        this._saveSessions();
        try { await this.sendResponse(channel, 'Session cleared. Send a new message to start fresh.'); } catch {}
      }
      return;
    }
    return super._onControlAction(action, payload);
  }

  /**
   * Cancel whatever is in flight for a channel: `session/cancel` first (lets
   * Devin wind down cleanly and keeps the session resumable), then a bounded
   * wait, then a hard process-tree kill if it didn't respond in time.
   */
  async _cancelChannel(channel, completionMessage) {
    const peer = this._peers[channel];
    if (!peer) return;
    this._stoppingChannels.add(channel);
    if (peer.currentTurn) peer.currentTurn.cancelledByUser = true;
    if (peer.sessionId && !peer.dead) {
      try { peer.notify(acp.buildCancelNotification(peer.sessionId)); } catch {}
    }
    const settled = await Promise.race([
      new Promise((resolve) => {
        const check = () => {
          if (!peer.currentTurn || peer.dead) { resolve(true); return; }
          setTimeout(check, 100);
        };
        check();
      }),
      new Promise((resolve) => setTimeout(() => resolve(false), CANCEL_GRACE_MS)),
    ]);
    if (!settled) {
      this._log(`Cancel did not settle for ${channel} within ${CANCEL_GRACE_MS}ms — terminating the process tree`);
      await this._stopProcess(peer.proc);
      delete this._peers[channel];
      delete this._channelQueues[channel];
      try { await this.sendResponse(channel, completionMessage); } catch {}
    }
    this._stoppingChannels.delete(channel);
  }

  stop() {
    const channels = Object.keys(this._peers);
    // Exposed (not just fire-and-forget) so callers that need every child
    // process tree actually gone before proceeding — the test suite's own
    // teardown, in particular — can await it.
    this._stopAllPeersPromise = Promise.all(
      channels.map((ch) => this._stopProcess(this._peers[ch].proc).catch(() => {})),
    );
    super.stop();
    return this._stopAllPeersPromise;
  }

  /**
   * Process-tree shutdown. Mirrors cursor.js's `_stopProcess` (Windows:
   * SIGINT then `taskkill /F /T`; POSIX: process-group SIGTERM then SIGKILL)
   * with one addition Devin's persistent stdio peer needs that a per-turn CLI
   * does not: close stdin FIRST and give the process a moment to notice
   * before signalling it, so a well-behaved `devin acp` gets the cleanest
   * possible shutdown path.
   */
  async _stopProcess(proc) {
    if (!proc) return;
    // Even a process that already exited on its own (e.g. it crashed mid-turn
    // and called its own process.exit()) can leave its stdio pipe handles
    // open a while longer — Node's 'exit' event (process gone) and 'close'
    // event (stdio streams fully flushed/closed) are not the same moment, and
    // on Windows a forcefully-terminated process's pipes can linger notably.
    // Destroying them explicitly, unconditionally, is what actually releases
    // the handle rather than waiting on it — skipping this whenever
    // `exitCode` was already non-null was exactly the gap that left orphaned
    // handles behind a "successful" stop().
    const destroyStdio = () => {
      try { proc.stdin && proc.stdin.destroy(); } catch {}
      try { proc.stdout && proc.stdout.destroy(); } catch {}
      try { proc.stderr && proc.stderr.destroy(); } catch {}
    };
    if (proc.exitCode !== null) { destroyStdio(); return; }
    try { proc.stdin.end(); } catch {}
    const body = (async () => {
      try {
        if (IS_WINDOWS) {
          try { proc.kill('SIGINT'); } catch {}
          const exited = await new Promise((resolve) => {
            if (proc.exitCode !== null) { resolve(true); return; }
            const timeout = setTimeout(() => resolve(false), 1500);
            proc.once('exit', () => { clearTimeout(timeout); resolve(true); });
          });
          if (!exited) {
            try { execSync(`taskkill /F /T /PID ${proc.pid}`, { timeout: 5000 }); } catch {}
          }
        } else {
          try { process.kill(-proc.pid, 'SIGTERM'); } catch {
            proc.kill('SIGTERM');
          }
          await new Promise((resolve) => {
            let done = false;
            const finish = () => { if (done) return; done = true; resolve(); };
            const timeout = setTimeout(() => {
              try { process.kill(-proc.pid, 'SIGKILL'); } catch {
                proc.kill('SIGKILL');
              }
              const reapTimeout = setTimeout(finish, 1000);
              proc.once('exit', () => { clearTimeout(reapTimeout); finish(); });
            }, 1500);
            proc.once('exit', () => { clearTimeout(timeout); finish(); });
          });
        }
      } catch {}
    })();
    // A hard outer cap. Every step above already has its own bound, but
    // `execSync('taskkill ...')`'s own `timeout` option is a best-effort
    // request to the OS, not a guarantee — a shutdown path must never be able
    // to hang the caller (a daemon stop/restart, or here, an adapter's own
    // stop()) indefinitely no matter what the underlying kill mechanism does.
    await Promise.race([body, new Promise((resolve) => setTimeout(resolve, 8000))]);
    destroyStdio();
  }

  // ------------------------------------------------------------------
  // Message handling
  // ------------------------------------------------------------------

  /**
   * A short per-turn context header prepended to every prompt. ACP has no
   * "system prompt" concept (unlike a per-turn CLI flag) — ContentBlock text
   * is the only channel available — so, like cursor.js (which has the same
   * constraint for the same reason: no system-prompt flag), this is repeated
   * on every turn rather than sent once.
   */
  _buildContextHeader(channel) {
    return `[workspace] You are agent '${this.agentName}', working in the '${channel}' channel of an OpenAgents workspace. Focus only on what this message asks.\n\n`;
  }

  /**
   * The full workspace briefing for a brand-new ACP session — identity, the
   * MCP tool names, collaboration rules, mode, the channel's pinned decision
   * log + glossary, and the standing guardrails (buildDevinSystemPrompt).
   * Prepended to the session's FIRST prompt only: it becomes part of the
   * persisted conversation, so it stays in context on later turns without
   * being re-sent — the same trick openworker.js uses, for the same reason
   * (no system-prompt channel). Resumed sessions (session/load) already
   * carry it in their history, so it is skipped there.
   */
  async _buildSessionBriefing(channel) {
    try {
      const browserEnabled = await this.getBrowserEnabled();
      return '[workspace briefing — applies to every message in this session]\n'
        + buildDevinSystemPrompt({
          agentName: this.agentName,
          workspaceId: this.workspaceId,
          channelName: channel,
          mode: this._mode,
          browserEnabled,
          model: this.modelLabel(),
          ...this.pinnedPromptOpts(channel),
        });
    } catch (e) {
      this._log(`Could not build workspace briefing (non-fatal): ${e.message}`);
      return '';
    }
  }

  async _handleMessage(msg) {
    let content = (msg.content || '').trim();
    const attachments = msg.attachments || [];
    const attText = formatAttachmentsForPrompt(attachments);
    if (attText) content = content ? content + attText : attText.trim();
    if (!content) return;

    const channel = msg.sessionId || this.channelName;
    this._stoppingChannels.delete(channel);
    const sender = msg.senderName || msg.senderType || 'user';
    this._log(`Processing message from ${sender} in ${channel}: ${content.slice(0, 80)}...`);

    if (!this._titledSessions.has(channel)) {
      this._titledSessions.add(channel);
      try {
        const info = await this.client.getSession(this.workspaceId, channel, this.token);
        const title = generateSessionTitle(content);
        if (title && !info.titleManuallySet && SESSION_DEFAULT_RE.test(info.title || '')) {
          await this.client.updateSession(this.workspaceId, channel, this.token, { title, autoTitle: true });
        }
      } catch {}
    }

    await this.sendStatus(channel, 'thinking...');

    let peer;
    let isNewSession = false;
    try {
      peer = await this._ensurePeer(channel);
      try {
        ({ isNew: isNewSession } = await this._ensureSession(channel, peer));
      } catch (e) {
        if (classifyAcpAuthError(e).isAuthError && await this._tryAuthenticate(peer)) {
          ({ isNew: isNewSession } = await this._ensureSession(channel, peer));
        } else {
          throw e;
        }
      }
    } catch (e) {
      const authClass = classifyAcpAuthError(e);
      if (authClass.isAuthError) {
        this._reportStatus(authClass.reason, authClass.message);
        await this.sendError(channel, authClass.message);
        return;
      }
      this._log(`Devin setup failed for ${channel}: ${e.message}`);
      await this.sendError(channel, `Devin could not start: ${redactSecrets(e.message)}`);
      return;
    }

    const briefing = isNewSession ? await this._buildSessionBriefing(channel) : '';
    const promptText = (briefing ? briefing + '\n\n' : '') + this._buildContextHeader(channel) + content;
    const turn = {
      channel, replaying: false, buffer: [], toolCalls: {},
      hasToolUseSinceLastText: false, postedAnything: false,
      cancelledByUser: false, lastActivityAt: Date.now(),
    };
    peer.currentTurn = turn;

    let idleTimer = null;
    let hardTimer = null;
    const clearTimers = () => { if (idleTimer) clearInterval(idleTimer); if (hardTimer) clearTimeout(hardTimer); };
    const startIdleTimer = () => {
      idleTimer = setInterval(() => {
        if (Date.now() - turn.lastActivityAt >= IDLE_NOTICE_MS && !turn._idleNoticeSent) {
          turn._idleNoticeSent = true;
          this.sendStatus(channel, 'Still working...').catch(() => {});
        }
      }, IDLE_NOTICE_MS);
    };

    let attemptedAuth = false;
    for (;;) {
      startIdleTimer();
      let response;
      try {
        response = await Promise.race([
          peer.request((id) => acp.buildPromptRequest(id, { sessionId: peer.sessionId, text: promptText })),
          new Promise((_, reject) => {
            hardTimer = setTimeout(() => reject(new Error('Devin turn exceeded the maximum allowed duration and was aborted.')), TURN_HARD_TIMEOUT_MS);
          }),
        ]);
      } catch (e) {
        clearTimers();
        peer.currentTurn = null;
        const authClass = classifyAcpAuthError(e);
        if (authClass.isAuthError && !attemptedAuth) {
          attemptedAuth = true;
          const authed = await this._tryAuthenticate(peer);
          if (authed) { peer.currentTurn = turn; continue; }
        }
        if (authClass.isAuthError) {
          this._reportStatus(authClass.reason, authClass.message);
          await this.sendError(channel, authClass.message);
          return;
        }
        if (turn.cancelledByUser) {
          // _cancelChannel already handled the kill + response for the
          // hard-timeout path; a graceful cancel resolves the request normally
          // (handled below) so reaching here means it was the hard kill.
          return;
        }
        this._log(`Devin turn failed for ${channel}: ${e.message}`);
        await this.sendError(channel, `Devin agent error: ${redactSecrets(e.message)}`);
        // The peer is unusable after a crash/broken-stream/hard-timeout
        // failure — kill it (a no-op if it already exited) so nothing is left
        // orphaned, and drop it so the next mention respawns a fresh process
        // and resumes via session/load, rather than leaving the channel wedged.
        await this._stopProcess(peer.proc);
        delete this._peers[channel];
        return;
      }
      clearTimers();
      // session/update notifications for this turn are earlier in the same
      // ordered stdout stream than the session/prompt response we just
      // received, but AcpPeer processes them through its own serialized
      // queue (see AcpPeer's _updateChain) rather than inline — so the queue
      // can still have work outstanding at this exact instant. Drain it
      // before reading turn.buffer, or a straggler chunk (most often the
      // tool_call case's narration flush) can be missed.
      await peer._updateChain;
      peer.currentTurn = null;

      const stopReason = (response && response.stopReason) || 'end_turn';
      const finalText = turn.buffer.map((b) => b.text).join('\n\n').trim();

      if (stopReason === 'cancelled') {
        // Always say plainly that the turn was cancelled — even when partial
        // text had already streamed, appending a fixed "Execution stopped."
        // fallback only when there was nothing else would silently drop the
        // cancellation signal into what looks like an ordinary short answer.
        const notice = finalText ? `${finalText}\n\n_(execution stopped)_` : 'Execution stopped.';
        try { await this.sendResponse(channel, notice); } catch {}
        return;
      }
      if (stopReason === 'refusal') {
        try { await this.sendResponse(channel, finalText || 'Devin declined to continue this turn.'); } catch {}
        return;
      }
      if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
        const note = stopReason === 'max_tokens'
          ? '\n\n_(stopped: reached the maximum response length — ask a follow-up to continue)_'
          : '\n\n_(stopped: reached the maximum number of agent steps for this turn — ask a follow-up to continue)_';
        try { await this.sendResponse(channel, (finalText || 'Working on it.') + note); } catch {}
        return;
      }
      // 'end_turn'
      if (finalText) {
        try { await this.sendResponse(channel, finalText); } catch {}
      } else if (!turn.postedAnything) {
        try { await this.sendResponse(channel, 'No response generated. Please try again.'); } catch {}
      }
      return;
    }
  }
}

module.exports = DevinAdapter;
