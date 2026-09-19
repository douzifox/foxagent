# FoxAgent 🦊

English | [中文](README.zh-CN.md)

FoxAgent is a standalone coding agent that runs on any OpenAI-compatible model
(DeepSeek, a local model, whatever is cheap) and plugs into Claude Code as an MCP
server. Claude Code keeps making the decisions; FoxAgent does the grind — code
review, exploration, mechanical edits — in its own persistent session, with a clean
context and a different model's eyes. It is not another Claude process. It is a
second, cheaper worker that can look at Claude's work from the outside.

You're working with a main agent like Claude Code. It spawns a sub-agent to read
code and try an approach. The sub-agent comes back with a result that's half right,
half wrong. Now you have two options: take over yourself, and every file that was
supposed to stay isolated floods into the main context; or spawn a new sub-agent,
which starts from zero and loses everything the previous one figured out. When a
sub-agent dies, everything in its head dies with it.

FoxAgent's answer: the sub-agent's session doesn't die. Dispatch work to it over
MCP, the task runs in its own session, and the main agent only gets back a
structured result plus the tail of the output. If it got something wrong, pass the
session id and tell it "X was wrong, Y is right, converge on what you already
found." It revises its judgment instead of redoing the work.

- **A second pair of eyes**: fox is a different model with a clean context, so it doesn't share Claude's blind spots — a code review dispatched to fox is a real second opinion, not Claude grading its own homework
- **Context isolation**: the dirty work burns in fox's session; by default the main agent receives only the last 1.5k characters plus a result summary
- **Resumable sessions**: `fox_sessions` finds past sessions, `fox_submit` with a session id continues one, and all the prior analysis is still there
- **Cost tiering**: fox talks to any OpenAI-compatible API, so a cheap model does the grind and the expensive one only makes decisions
- **No caller-side babysitting**: hang detection, token budget, and context compaction all live inside fox

It's also a standalone terminal CLI: seven tools, file edits applied automatically
with confirmation only for dangerous commands, streaming output, sessions saved to
disk, two layers of memory plus an automatic work journal. Bun + TypeScript, about
3,000 lines, one runtime dependency.

Every design trade-off is recorded in [docs/decisions.md](docs/decisions.md)
(in Chinese), each with its reasoning and the alternatives that were rejected.

## Install

Prerequisites: [Bun](https://bun.sh), [ripgrep](https://github.com/BurntSushi/ripgrep)
(the `search` tool depends on it), and the URL, key, and model name of any
OpenAI-compatible API.

```bash
git clone https://github.com/douzifox/foxagent.git ~/foxagent
cd ~/foxagent && bun install
```

Commands below assume the clone lives at `~/foxagent`; adjust the path if you put it elsewhere.

## Configuration

Environment variables come first; if they're missing, `~/.config/foxagent/env` is
read as a fallback (one `KEY=VALUE` per line, environment variables take
precedence). The fallback exists for processes launched from a GUI (such as the MCP
server) that can't see your shell config. Hard rule for secrets: they never go into
the project directory.

```bash
# Required (put in ~/.zshrc, or Windows system environment variables)
export FOXAGENT_HOST=https://api.deepseek.com   # or your gateway's /v1 URL
export FOXAGENT_API_KEY=sk-xxx
export FOXAGENT_MODEL=deepseek-v4-flash          # model name, see window convention below

# Optional (defaults are sensible, usually no need to set)
export FOXAGENT_NUM_CTX=200000     # compaction trigger window (default 200k; models tagged [1m] get 1M automatically)
export FOXAGENT_TEMPERATURE=0.3
export FOXAGENT_MAX_TOKENS=1000000 # optional cost guardrail (unlimited by default); only active when set: warns to wrap up at 80%, writes a progress summary before the hard stop
export FOXAGENT_MAX_ITERS=500      # cap on response rounds, only guards against infinite loops (use MAX_TOKENS to bound task size)
```

### Model window convention

A model name is treated as a **200k** window by default. Append `[1m]` for models
with a 1M window:

```bash
export FOXAGENT_MODEL=deepseek-v4-flash         # → 200k window
export FOXAGENT_MODEL=deepseek-v4-flash[1m]     # → 1M window
```

`[1m]` is stripped before the request goes to the API. It's the **switch for the
whole 1M mode**: the compaction window rises to 1M (compaction happens later, API
cache hits go up). `FOXAGENT_NUM_CTX` only overrides the default (200k); with `[1m]`
present, 1M wins. If you want earlier compaction (forced distillation, faster and
cheaper per round), just use the model name without `[1m]`. The effective window and
guardrail are shown on the startup line (guardrail shows "unlimited" by default).

## Terminal CLI

```bash
cd your-project
bun ~/foxagent/src/cli.ts             # continues the project's most recent session by default
bun ~/foxagent/src/cli.ts --new       # start a new session

# In-session commands
/new          start a new session
/sessions     list past sessions
/resume <id>  resume a specific session
/exit         quit

# Controls
Esc           interrupt the current turn (session is kept)
Ctrl+C        quit (auto-saves)
↑             while working, pull a queued message back to edit it
Enter         while working, queue the message; it's sent when the turn ends

# Non-interactive mode (for other agents to call)
bun src/cli.ts -p "task description"              # run to completion and exit
bun src/cli.ts -p "follow-up" --continue          # continue the most recent session
bun src/cli.ts -p "follow-up" --session <id>      # continue a specific session (parallel tasks don't cross wires)
```

`-p` mode talks to the caller in both directions: dangerous-command confirmations
and the model's ask questions print one line of `@@ASK@@{...}` to stdout and wait
for one line of reply on stdin (no one listening counts as refused / offline). On
finish it prints one line of `@@RESULT@@{outcome, filesChanged, committed, error,
sessionId}`, a structured summary that keeps results and accidents separate. Exit
code: 0 = something was produced (including partial success where it crashed after
finishing the work), 1 = nothing at all.

## MCP server (driven by Claude Code and others)

Registered as a global MCP server, any MCP client can dispatch work to FoxAgent:

```bash
claude mcp add --scope user foxagent -- bun ~/foxagent/src/mcp.ts
# put the three secrets in the env field of the foxagent entry in ~/.claude.json, or use the fallback file
```

Six tools make up an async task model: `fox_submit` (returns a taskId immediately;
optionally takes `maxTokens` as a cost guardrail, unlimited by default) → `fox_wait`
(blocks until the result, zero polling; if timeoutSec passes without completion it
returns a running signal to renew the lease, call again to keep waiting; returns
question immediately when the task asks something) or `fox_check` (a look-only
snapshot, a few dozen tokens: runtime, seconds of silence, tool call count, last
call; omit taskId to see every task at once) or `fox_status` (takes the incremental
output; when a task ends interrupted it includes resume guidance) → `fox_reply`
(answer a question, task continues); `fox_sessions` (lists the project's past
sessions: latest task, last reply summary, round count. A new caller uses it to find
a session before resuming, seamless handoff across sessions). The task table lives
only in memory; restarting the MCP server drops it. The full trace lands in
`~/.foxagent/projects/<path>/runs/<taskId>.log` (`fox_status` returns that path in
every state; if you suspect a hang, just tail it). Resume an interrupted task with
`fox_submit` and `session=result.sessionId`; the prior analysis context is still there.

Compile to a single file (no bun/node needed, copy and run):

```bash
bun run cli:compile        # current platform → ./foxagent
bun run cli:compile:win    # cross-compile for Windows → foxagent.exe
```

## Data storage

Everything lives under `~/.foxagent/`, nothing is written into your project directory:

```
~/.foxagent/
  FOXAGENT.md                              global instructions (cross-project, injected in full)
  projects/<project-path>/
    sessions/<id>.json                     sessions (with thinking and journal staging)
    memory/MEMORY.md                       project memory index (injected)
    memory/<slug>.md                       one file per memory (read on demand)
    journal.md                             work journal (injected in full)
    runs/<taskId>.log                      full trace of MCP tasks
```

The interactive CLI and -p/MCP read and write the same sessions: work started in the
terminal can be continued by dispatching a task with that session.

## Context compaction

Usage is estimated before each request; compaction triggers past 90% of the window
(aligned with Claude Code's auto-compact: compaction is lossy, so keep as much raw
detail as possible, and context caching has already amortized the cost of long
history). While the history is still complete (tool output is never pre-trimmed),
the model produces one full summary that replaces the earlier text. Compaction
invalidates the API cache for that round (a known cost); the bigger the window, the
less compaction and the better the cache hits. That's why the `[1m]` convention
exists; if you want early compaction (forced distillation), use the model name
without `[1m]`.

## Memory

- **Global instructions** `~/.foxagent/FOXAGENT.md`: cross-project preferences and requirements, injected in full into every session
- **Project memory** `~/.foxagent/projects/<path>/memory/`: one md file per memory (with a name/description/type metadata header), `MEMORY.md` is the index. A new session only gets the index injected; the agent reads details itself when the description looks relevant. It checks for duplicates before writing and deletes stale entries. All plain text, edit by hand freely

## Work journal

After every **task** (not every conversational turn), code appends to `journal.md`
automatically: time, task, changes (merged per file with counts), commands (capped),
pitfalls (failed operations plus error messages), result. Flushed on a successful
`git commit` or when the session switches or exits. Injected in full into new sessions.

## Wrap-up

When a task hit pitfalls (failed edits, non-zero command exits), code automatically
appends one wrap-up request: the pitfall list is handed to the model to decide whether
it's worth saving to project memory. The wrap-up exchange is not added to the formal
session history.

## Security

The goal is to catch slips, not to resist an adversary: dangerous commands are caught
by a regex blocklist, and things like `find -delete` or `git branch -D` slip through.
File edits are applied automatically, with git as the safety net. Don't run it in a
repository you don't trust.

- Paths are locked to the workspace plus `~/.foxagent/`; redirects must pass the allowlist too
- Tool arguments are shell-escaped against injection
- Dangerous commands are tiered and intercepted (rm / sudo / git push, etc.); the list in `tools.ts` is adjustable
- Line-number contamination detection in edit (when the model copies the display line-number prefix into replacement text, it errors out and self-corrects)
- Atomic session writes (temp file + rename), one corrupted file doesn't affect other sessions
- ANSI sanitization of terminal output (guards against the model returning control sequences that manipulate the terminal)
- In `-p` mode, dangerous commands go through the `@@ASK@@` sentinel to the caller and only run on a `y`; no listener (stdin closed) counts as refused

## Prompt

The default prompt lives in `src/prompt.ts`. Put a `system-prompt.md` in the root of
the project being operated on to override it: tuning without touching code, takes
effect in the next new session.

## Development

```bash
bun install      # install dependencies
bun run check    # type check (no build step, bun runs ts directly)
bun run cli      # run the CLI in the current directory
```

After changes, always run `bun run check`, then do a smoke test in `-p` mode.
Design decisions are in `docs/decisions.md`, architecture in `docs/architecture.md`
(both in Chinese).

## License

[MIT](LICENSE)
