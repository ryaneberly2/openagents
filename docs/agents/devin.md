# Devin CLI

[Devin CLI](https://devin.ai/cli) — Cognition's autonomous software engineer —
run as an OpenAgents agent over the **Agent Client Protocol (ACP)**
(`devin acp`), the same interface Devin documents for host integrations like
Zed and Windsurf.

Unlike every other adapter in this package, which spawns one CLI invocation
**per turn**, Devin's ACP interface is a long-lived stdio JSON-RPC peer: one
`devin acp` process stays running for the life of a channel's conversation,
and each turn is a `session/prompt` request sent to that same process.

## Why ACP, not `devin -p`

`devin -p` prints one response and exits: no structured streaming, no
permission round-trip, no session handle to resume, and it refuses to run in
an untrusted directory at all unless `--respect-workspace-trust false` is
passed. None of that supports channel-scoped conversations with follow-up
turns, live progress, or cancellation — the ACP interface is the only one
that does, and it is what this adapter uses exclusively. `devin --version` /
`devin version` are used only as install/readiness diagnostics, never as the
conversation transport.

## The wire format

ACP is JSON-RPC 2.0 over stdio, one message per line (newline-delimited JSON
— **not** the LSP-style `Content-Length` header framing). See
[agentclientprotocol.com](https://agentclientprotocol.com) and the
[schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)
for the authoritative spec; `src/adapters/devin-acp.js`'s file header cites
the exact methods and cross-references Devin's own docs.

This client (`src/adapters/devin.js` + `devin-acp.js`) calls `initialize`,
`authenticate`, `session/new`, `session/load`, `session/prompt` and sends
`session/cancel`; it answers the agent's `session/update` notifications and
`session/request_permission` requests. It does **not** advertise `fs`/
`terminal` client capabilities — Devin's ACP server runs its own tools
natively against the working directory it was given, so no file-I/O bridge is
needed the way a thin ACP shim would require one.

## Install

```bash
# macOS / Linux
curl -fsSL https://cli.devin.ai/install.sh | bash

# macOS (Homebrew)
brew install --cask devin-cli

# Windows (PowerShell — not Git Bash/CMD)
irm https://static.devin.ai/cli/setup.ps1 | iex
```

```bash
agn install devin
agn create my-devin --type devin
agn connect my-devin <workspace-token>
```

Binary locations (verified against the real installers, not guessed):

| Platform | Binary lands at |
|---|---|
| macOS/Linux | `~/.local/bin/devin` (symlink) → `$XDG_DATA_HOME/devin/cli/_versions/<version>/bin/devin` (`XDG_DATA_HOME` defaults to `~/.local/share`) |
| Windows | `%LOCALAPPDATA%\devin\cli\bin\devin.exe`, added to the **user PATH registry key** |

The Windows install edits the registry PATH, which an already-running daemon
never sees until restarted — the same staleness Cursor/Amp/Hermes hit, and
`paths.js` accounts for it the same way (see `getKnownBinDirs()`). Detection
never trusts a leftover marker alone: `installer.js`'s `_verifyDevinBinary()`
confirms a real, resolvable `devin` exists on disk before recording an
install as successful, the same defense aider/amp/cursor/hermes already have
against an installer script that degrades to a warning and still exits 0.

## Authentication

This agent does **not** invent its own credential store. It reuses whichever
of these the operator has already set up:

1. **`devin auth login`**, run once in a real terminal on this machine.
   Devin's own ACP server reads that login automatically.
2. **`WINDSURF_API_KEY`** or **`DEVIN_API_KEY`**, set with
   `agn env devin --set WINDSURF_API_KEY=...` — the env var Devin's ACP
   server itself checks first, before falling back to a `devin auth login`
   session.

If a turn fails because Devin reports it isn't authenticated (ACP's
`-32000 Authentication required` error), the adapter classifies this through
`src/adapters/health-status.js`'s `classifyAcpAuthError()` — distinctly from
"not installed" — and:

- If a key is present and Devin advertised a non-terminal auth method during
  `initialize`, it makes one `authenticate` attempt with that key and retries.
- Otherwise it tells the channel plainly: run `devin auth login`, or set
  `WINDSURF_API_KEY`/`DEVIN_API_KEY`, then send the message again.

There is no headless browser/OAuth flow attempted — nothing running inside
this daemon can complete one. Readiness is also checked at the registry
level via `devin auth status` (`registry/devin.json`'s `check_ready`), so the
agent picker shows "installed but not signed in" as a distinct state from
"not installed" even before a message is ever sent.

**No credential material is ever logged.** Redaction reuses
`src/adapters/utils.js`'s `redactSecrets()` (the same helper claude.js,
cline.js and codebuddy.js already use) on every error message and logged ACP
frame.

## Session continuity

One ACP session per workspace channel, tracked exactly the way cursor.js and
claude.js track theirs:

```
~/.openagents/sessions/<workspaceId>_<agentName>_devin.json   # channel → Devin ACP session id
```

A follow-up mention in the same channel resumes that session via
`session/load` (Devin replays the conversation history over `session/update`
notifications first — this adapter suppresses re-posting that replay, since
the channel already has it). If the resume is rejected (expired session,
unknown id, or the peer doesn't support `session/load` at all), the adapter
falls back to a fresh `session/new` and tells the channel so explicitly.
Different channels never share a session id.

## Working directory

`this.workingDir` (set from `agn create --path`, or the agent's default
workspace directory otherwise) is passed as `cwd` on every `session/new` /
`session/load` call, and the `devin acp` process itself is spawned with that
same `cwd`. `--respect-workspace-trust false` is always passed as a global
flag ahead of the `acp` subcommand, so a headless daemon never stalls on the
interactive workspace-trust prompt.

## Model and permission mode

| Env var | Effect |
|---|---|
| `DEVIN_MODEL` | Passed as `devin acp --model <value>`. Fuzzy names (`opus`) are accepted, per Devin's own docs. Leave unset for Devin's default. |
| `DEVIN_PERMISSION_MODE` | How this adapter answers ACP `session/request_permission` requests — see below. |

**Nobody is attached to this stdio pipe to click "approve."** Every
permission mode therefore answers automatically; they differ only in *how
much* they narrate to the channel and whether they ever pick a "remember this
choice" option:

| Mode | Behavior |
|---|---|
| `smart` (**default**) | Approves once (never "always"). Low-risk tool kinds (read/search/fetch/think) are approved silently; edit/execute/delete/move are approved once **and narrated** to the channel, so an operator watching sees every consequential decision even though nothing blocked on them. |
| `accept-edits` | File edits are auto-approved silently; every other kind is approved once and narrated. |
| `dangerous` / `yolo` / `bypass` | Approves everything, preferring "always" when offered, silently. |
| `autonomous` | Same as bypass, and additionally passes `--sandbox` to `devin acp` (per the ticket's own requirement — never combine autonomous approval with an unsandboxed run). |

The default is deliberately **not** a bypass mode — see
`src/adapters/devin-acp.js`'s `normalizePermissionMode()` for the reasoning
in code.

## Streaming, cancellation, and failure recovery

- **Streaming**: `agent_message_chunk` / `agent_thought_chunk` updates are
  posted via `sendThinking()` as they arrive; `tool_call` / `tool_call_update`
  and `plan` updates are posted via `sendStatus()`. The final answer — the
  concatenated text of the last message, reset whenever a tool call
  intervenes — is posted via `sendResponse()` once the turn's `stopReason`
  comes back.
- **Cancellation**: a stop sends ACP's `session/cancel` notification first
  (lets Devin unwind cleanly and keeps the session resumable), waits up to 8
  seconds, and only then force-kills the process tree if it hasn't settled.
  Either way the channel gets a completion message and the session stays
  resumable on the next mention.
- **Process-tree shutdown** (stop/restart/daemon bounce) mirrors cursor.js's
  Windows-vs-POSIX kill pattern (`SIGINT` → `taskkill /F /T` on Windows;
  process-group `SIGTERM` → `SIGKILL` on POSIX), with stdin closed first so a
  well-behaved peer gets the cleanest possible shutdown.
- **A killed/crashed process mid-turn**, and separately a malformed/aborted
  ACP byte stream (five consecutive unparseable lines), are both reported to
  the channel as an agent error and the peer is torn down — the next mention
  spawns a fresh process and resumes via `session/load`. No daemon restart is
  needed and the channel is never left in a wedged "busy" state.

## Not exposed over ACP / limitations

- **No `fs/*` or `terminal/*` bridge.** This client doesn't advertise those
  capabilities; Devin's ACP server runs its own tools directly against the
  working directory instead of asking the client to proxy file I/O.
- **No interactive human-in-the-loop for permission requests.** See the
  permission-mode table above — every decision is automatic.
- **`--respect-workspace-trust false`'s exact placement relative to the `acp`
  subcommand is an inference from Devin's documented flag list**, not
  something verified against a running binary (Devin's docs describe the flag
  but not its precise position). Verify this against a real installed `devin`
  before relying on it in a security-sensitive deployment.
- **Windows**: install/detect/binary-resolution and process-tree termination
  all have Windows-specific handling and are believed to work, but were only
  exercised against a scripted fake ACP peer on this fork's development
  machine (also Windows) — not against the real `devin.exe`. See the test
  report for exactly what was and wasn't proven with a real binary.

## Verifying a live install

```bash
devin auth status          # confirms sign-in outside the daemon
agn create my-devin --type devin
agn connect my-devin <workspace-token>
# mention @my-devin in a channel; watch for streamed progress, then an answer
# mention it again in the same channel; confirm the session id in
#   ~/.openagents/sessions/<workspace>_<agent>_devin.json is unchanged
# ask it to edit a file; confirm the change under `git status` in the
#   agent's working directory
# ask it to do something slow, then run the /stop (or equivalent) control
#   action; confirm a prompt cancellation notice and that a follow-up message
#   still works without restarting the daemon
```
