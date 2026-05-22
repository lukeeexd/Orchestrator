# Orchestrator

A self-hosted Windows desktop app that runs an LLM **Director** which chats with you and spawns specialised **agents** (pm / researcher / coder / qa / devops / security) to do the work.

Built on top of the `claude` (and optionally `codex`) CLIs you already have installed — Orchestrator drives them; it doesn't bundle them.

> Single-user, self-hosted, Windows-only for now. v0.6.0.

## What it does

- **Director chat** in one pane: describe the task, get back a plan, accept it, watch agents run.
- **Six agent roles** with role-specific system prompts, tool allow-lists, and per-role skill slots:
  - `pm` — read-only, decomposes work
  - `researcher` — read + web fetch, writes findings to disk
  - `coder` — read + edit + shell, implements
  - `qa` — read + edit + shell, writes and runs tests
  - `devops` — read + shell, builds and deploys
  - `security` — read + shell + web, audits for vulnerabilities
- **Live drawer** per agent: KPI strip (Step / Tokens / Cost / Elapsed), tools usage, context tab, system prompt, pause.
- **Sequential auto-spawn** so the Director runs `pm → coder → qa` in order, not all at once.
- **Per-agent budgets** in dollars, tokens, or wall-clock seconds. Hard-stop on exceed.
- **Session persistence** — Director chat, agents, log lines all rehydrate on restart.
- **Spend screen** with real per-day cost chart and a deep link to claude.ai for official usage.
- **Two providers** — Claude (default) or Codex (`codex exec --json`). Each project picks one at creation.
- **Auto-update** via `update-electron-app` against `update.electronjs.org` (Microsoft-operated, TLS-pinned to GitHub Releases) every 10 minutes.

## Install

Grab the latest `Orchestrator-Setup.exe` from the [Releases page](https://github.com/lukeeexd/Orchestrator/releases/latest) and run it. SmartScreen will warn — the build isn't code-signed.

Once installed, Orchestrator updates itself in-place. A pill appears in the top bar when a new version finishes downloading.

You'll also need at least one of:

- **Claude** — `claude` CLI installed and logged in (Anthropic API key, Claude Code OAuth, or Claude Team plan login all work).
- **Codex** — `codex` CLI installed and logged in. ChatGPT-plan users are supported; `gpt-5-codex` is the default model.

Orchestrator detects which CLIs are present and gates project creation accordingly.

## Develop

```bash
git clone https://github.com/lukeeexd/Orchestrator.git
cd Orchestrator
npm install
npm start
```

Stack: Electron Forge + Vite + React 19 + TypeScript + `sql.js` (WASM SQLite). The main process holds the runtime; the renderer is a three-pane shell (Director / Agents / Drawer). Branch model is `dev` → `main`; tags `vX.Y.Z` on `main` trigger the release workflow.

To produce a Windows installer:

```bash
npm run make
```

Output lands at `out/make/squirrel.windows/x64/Orchestrator-Setup.exe`.

## Architecture in one breath

The main process spawns `claude` (or `codex`) as a child process per agent and streams the structured event log back over typed IPC. The renderer holds a `useAgents` hook that mirrors that stream into the UI. The Director itself is just another long-running session — its outputs include a fenced `orchestrator-plan` JSON block that the UI parses into the plan card.

For the longer story (decisions locked, milestones, deferred features), see [`PLAN.md`](./PLAN.md). For UI work, see [`docs/design/README.md`](./docs/design/README.md).

## Status & contributions

This is a single-developer project. Issues are welcome; PRs are accepted on a case-by-case basis. The roadmap in `PLAN.md` is the source of truth for what's coming next.

## License

MIT.
