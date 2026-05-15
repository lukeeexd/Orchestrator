# Orchestrator — v1 Plan

> A self-hosted Windows desktop app that runs an LLM **Director** which chats with the user and spawns specialised **agents** (pm / researcher / coder / qa / devops) to write code. Built on the Claude Agent SDK.

## How to use this doc

This file is the source of truth for what the project is, where it stands, and what to build next.

- **Update the Status section + Milestone checkboxes** as work progresses.
- A new Claude Code session should read this file, then `docs/design/README.md`, then proceed from "Current milestone".
- Decisions move from "Open questions" → "Decisions locked" once confirmed by the user. Do not silently revisit a locked decision.

## Status

| Field | Value |
|---|---|
| Current milestone | **M1 — not started** |
| Last updated | 2026-05-15 |
| Repo | `github.com/lukeeexd/Orchestrator` (private). Branches: `main` (release), `dev` (working). |

## Decisions locked

| Decision | Choice | Notes |
|---|---|---|
| Orchestration model | Director-led | An LLM Director plans and delegates; not manual routing |
| Frontend shell | Electron Forge + Vite + React + TypeScript | TS-first because the Claude Agent SDK is TS |
| Agent runtime | `@anthropic-ai/claude-agent-sdk` | One in-process session per agent |
| Storage | `sql.js` (WASM SQLite, main process only) | Originally `better-sqlite3`; swapped because native rebuild needs a Python + MSVC toolchain not present on the dev machine. WASM is portable and fine for single-user scale. Revisit if perf bites. |
| Per-agent isolation | Git worktrees on the user's target repo | No auto-PR / auto-merge in v1 |
| Repo target | User points the app at a folder; agents work there | Manual merge back in v1 |
| API keys | Plain JSON in user data dir | Move to OS keychain in v1.1 |
| Branch model | `dev` → `main`, mirrors KnittingApp | Releases tagged on main |
| Packaging | electron-builder NSIS | Windows-only for v1 |
| Repo location | `github.com/lukeeexd/Orchestrator`, private | Created at M0 with `--source . --push` |

## v1 fleet (the five roles)

| Role | Color | System prompt focus | Default tool set |
|---|---|---|---|
| pm | green | Decompose, sequence, surface dependencies | read-only |
| researcher | blue | Read docs, web fetch, summarise | read + web |
| coder | purple | Read + edit + run tests | read + edit + shell |
| qa | amber | Write/run tests, report failures | read + edit + shell |
| devops | orange | Build, deploy, CI | read + shell |

System prompts are authored in M4. Tool allow-lists are hardcoded in v1; user-editable allow-lists land in v1.1 with the Tools screen.

## Out of scope for v1

The rail nav has slots for these; in v1 they route to a "Coming in v1.1" placeholder screen.

- Templates (saved agent fleets)
- Tools registry (per-role allow-lists)
- Spend (cost analytics, history)
- Runs (past sessions browser)
- Settings beyond a single API-key field

## Milestones

### M0 — Skeleton  *(completed 2026-05-15)*

- [x] `gh repo create Orchestrator --private --source . --push` from the scaffold dir
- [x] Electron Forge with Vite + TS template (TS bumped from pinned 4.5.4 to ^5.5)
- [x] Folder layout: `src/main`, `src/preload`, `src/renderer`, `src/shared`
- [x] Typed IPC scaffold (`IpcChannels` enum + `OrchestratorApi` surface in `src/shared/ipc.ts`); ping + settings get/set handlers prove the bridge
- [x] `sql.js` wired with an empty schema and a versioned migration runner (swapped from better-sqlite3 — see Decisions locked)
- [x] Settings JSON in Electron's `userData` dir with `apiKey` and `defaultModel` fields
- [x] Window opens with the design's `--ink` (`#08090b`) background, JetBrains Mono fallback chain, 1440×900 default, devtools detached in dev
- [x] Design handoff copied to `docs/design/`
- [x] `dev` branch created off `main`, both pushed to the private repo

### M1 — UI shell empty-state  *(not started)*

- [ ] Design tokens lifted from `docs/design/design-reference/styles.css` into CSS vars
- [ ] TopBar (38px), LeftRail (52px), StatusBar (24px)
- [ ] Three panes: Director (resizable 300–640, default 400) / Agents (flex) / Drawer (resizable 340–680, default 460)
- [ ] Draggable resize handles with accent-green hover glow + snap to min/max
- [ ] Persist `dirW` and `drawerW` to localStorage
- [ ] Empty states matching `docs/design/screenshots/empty-state.png`
- [ ] JetBrains Mono bundled as a webfont, `tabular-nums` global
- [ ] Rail nav items (Templates / Spend / Runs / Settings) route to placeholder screens

### M2 — Single-agent loop  *(not started — hardest milestone)*

- [ ] Bypass Director temporarily: pick role + type task → spawn one SDK session in a fresh worktree
- [ ] **Event classifier**: SDK stream events → `LogLine[]` with the design's 7 kinds
  - assistant text → `THOUGHT`
  - tool_use → `TOOL` (structured args)
  - tool_result → `RESULT`
  - errors → `WARN` / `ERROR`
  - meta-tool `pin_note(...)` → `NOTE`
  - meta-tool `complete_task(...)` → `HANDOFF`
- [ ] Worktree lifecycle: create on spawn, prune on done, clean conflict handling
- [ ] Agent row in workspace pane with chevron expand → inline structured log
- [ ] One running role end-to-end before adding the other four

### M3 — Drawer wired  *(not started)*

- [ ] Click agent → drawer opens, KPI strip (Step · Tokens · Cost · Elapsed) live
- [ ] **Logs tab**: current task, spawner, last 8 log lines
- [ ] **Tools tab**: per-tool invocation count + last-used relative time
- [ ] **Context tab**: token-window breakdown from SDK usage telemetry
- [ ] **Config tab**: system prompt (collapsible) + model + budgets + on-error policy
- [ ] Action buttons: **Pause** / **Redirect** / **Fork** / **Approve**
- [ ] **Spike before starting**: does the SDK support session resume from message N? If not, Fork = replay log into a fresh session + branch the worktree

### M4 — Director  *(not started)*

- [ ] Director system prompt (planner-supervisor role)
- [ ] `propose_plan` tool: emits structured `PlanRow[]`; UI intercepts and renders the plan card
- [ ] Plan card editable in the Director pane; on confirm Director gets a `plan_accepted` user message
- [ ] `spawn_agent` tool: Director calls it once per row of the accepted plan
- [ ] System messages render in the Director chat ("Spawned 6 agents · pm-01 running")
- [ ] HANDOFF flow: agent calls `complete_task` → emits `HANDOFF` log line → Director notified next turn

### M5 — Budgets + polish  *(not started)*

- [ ] Per-agent transport wrapper that meters tokens + dollars
- [ ] Hard-stop on budget exceeded → status `error`
- [ ] Pulse animation (1.6s ease-in-out) on running and approval dots
- [ ] Streaming cursor on live Director messages and tail log lines
- [ ] Session persistence across app restart (reload from SQLite)
- [ ] Memory pins via the SDK's memory tool

### M6 — Installer + dogfood  *(not started)*

- [ ] electron-builder NSIS installer config
- [ ] Decide on code signing (cost vs. SmartScreen warnings)
- [ ] Use on a real task in another repo, file issues
- [ ] Tag v0.1.0 on main

## Hardest unknowns (spike when their milestone arrives)

1. **Event classifier (M2)** — THOUGHT vs NOTE is fuzzy. Plan: assistant text deltas always become THOUGHT; NOTE only appears when the agent explicitly calls the `pin_note` meta-tool.
2. **Fork semantics (M3)** — Whether the SDK supports session resume from message N. If not, fork replays the existing log into a fresh session.
3. **Plan card I/O (M4)** — Conversational feel + structured output. Resolved via a `propose_plan` tool call that the UI intercepts (the Director never has to emit JSON in chat).
4. **HANDOFF (M4)** — How the Director knows an agent finished. Resolved via a required `complete_task` tool that emits the HANDOFF line and updates agent status to `done`.

## References

- Design handoff (read this before any UI work): [`docs/design/README.md`](./docs/design/README.md)
- Screenshots: `docs/design/screenshots/`
- React + CSS reference: `docs/design/design-reference/`
- Sibling project (release-workflow patterns to mirror): `D:\ClaudeCode\KnittingApp`

## Recently completed

- **2026-05-15 — M0 Skeleton.** Forge scaffold reorganised into four-pane src layout. Typed IPC bridge proves end-to-end. sql.js stood in for better-sqlite3 (no native compile toolchain). Window opens on `--ink` background, first commit on `main`, working branch `dev` pushed.
