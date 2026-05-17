# Orchestrator — Plan

> A self-hosted Windows desktop app that runs an LLM **Director** which chats with the user and spawns specialised **agents** (pm / researcher / coder / qa / devops / security) to write code. Drives the user's installed `claude` (and optionally `codex`) CLI — no SDK bundled.

## How to use this doc

This file is the source of truth for what the project is, where it stands, and what to build next.

- **Update the Status section + Milestone checkboxes** as work progresses.
- A new Claude Code session should read this file, then `docs/design/README.md`, then proceed from "Current focus".
- Decisions move from "Open questions" → "Decisions locked" once confirmed by the user. Do not silently revisit a locked decision.

## Status

| Field | Value |
|---|---|
| Current focus | **Post-v1 cadence — roughly one minor every couple of days.** Next: v0.7.0 (first end-to-end test of the curated-tag-body release-notes workflow). |
| Latest release | **v0.6.0** (Director skill slot) |
| Last updated | 2026-05-18 |
| Repo | `github.com/lukeeexd/Orchestrator` (**public** as of 2026-05-17). Branches: `main` (release), `dev` (working). |

## Decisions locked

| Decision | Choice | Notes |
|---|---|---|
| Orchestration model | Director-led | An LLM Director plans and delegates; not manual routing |
| Frontend shell | Electron Forge + Vite + React + TypeScript | TS-first because the original runtime (Claude Agent SDK) was TS |
| Agent runtime | **Shell out to the user's installed `claude` (or `codex`) CLI** via `child_process.spawn`, structured-event stream over stdout | Originally the `@anthropic-ai/claude-agent-sdk` was bundled, but the 218 MB `claude.exe` it shipped made the installer huge and asar-hostile (see [a0676b8]). v0.2.0 onward we drive the user's own CLI install and stay out of the binary-distribution business. |
| Providers | `claude` (default) and `codex` (`codex exec --json`) | Each project picks one at creation. Codex Fork is disabled (no `--json` mode for `codex fork`); ChatGPT-plan codex users skip the `-m` flag. |
| Storage | `sql.js` (WASM SQLite, main process only) | Originally `better-sqlite3`; swapped because native rebuild needs a Python + MSVC toolchain not present on the dev machine. WASM is portable and fine for single-user scale. Revisit if perf bites. |
| Per-agent isolation | None — sequential agents share the workspace | Original M2 plan used git worktrees; dropped after M4 once we made spawning sequential. Worktrees prevented downstream agents from reading what upstream agents had written. |
| Repo target | User points the app at a folder; agents work there | Manual merge back |
| API keys | Plain JSON in user data dir | OS keychain still pending — not yet a priority for a single-user app |
| Branch model | `dev` → `main`, mirrors KnittingApp | Releases tagged on main; tags `vX.Y.Z` trigger `.github/workflows/release.yml` which builds the installer and creates the GitHub Release. Curated notes live in the annotated tag body. |
| Packaging | Electron Forge `MakerSquirrel` (`.exe` installer) | Windows-only. Switch to `MakerWix` if `.msi` becomes a requirement. |
| Auto-update | `update-electron-app` polling `update.electronjs.org` every 10 min | Only works because repo is public (`update.electronjs.org` doesn't serve private repos). Pill appears post-download, not at check time. |
| ASAR integrity fuses | `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` **deliberately off** | Re-enabling them in v0.4.0 broke installs silently (process launched, integrity check failed, no error dialog). Don't re-enable without verifying the integrity-hash flow end-to-end through Squirrel. |
| Repo location | `github.com/lukeeexd/Orchestrator`, **public** as of 2026-05-17 | History was rewritten before the privacy flip to scrub personal identifiers. Do not reintroduce real name / personal email anywhere. |

## The fleet (six roles + Director)

| Role | Color | System prompt focus | Default tool set |
|---|---|---|---|
| pm | green | Decompose, sequence, surface dependencies | read-only |
| researcher | blue | Read docs, web fetch, summarise | read + web |
| coder | purple | Read + edit + run tests | read + edit + shell |
| qa | amber | Write/run tests, report failures | read + edit + shell |
| devops | orange | Build, deploy, CI | read + shell |
| security | red | Audit code for vulns / unsafe patterns / leaked secrets | read + shell + web (read-only by default) |

Director itself runs as a long-lived planner-supervisor session. From v0.6.0 it also has its own skill slot, mirroring per-agent skills.

System prompts live in `src/shared/roles.ts`. Tool allow-lists are hardcoded; user-editable allow-lists are still on the deferred list.

## Out of scope (placeholder rail items)

The rail nav has slots for these; they route to a "coming soon" placeholder screen.

- Templates (saved agent fleets)
- Most of Settings beyond API-key / provider / model / Director-default fields

Already shipped (no longer placeholders): the **Spend** screen (real per-day cost chart + deep link to claude.ai for official usage), the **Runs/History** screen (real list of past agents — see `HistoryScreen.tsx`), and the **Tools** screen / per-project per-role tool allow-list overrides (`ProjectSetRoleTools` IPC + `ToolsScreen.tsx`).

## Already-shipped post-v1 features (formerly deferred)

What was deferred at v1.0 and has since landed. Kept here so future "next slice" hunts don't re-propose finished work.

- **Agent Fork.** Drawer Fork button is enabled when the parent has a captured `session_id` (any provider except codex — `codex fork` is TUI-only). Uses `claude --resume <id> --fork-session` so the parent stays intact; agent records `forkedFromId` / `forkedFromName`. See `forkAgent` in `src/main/agents/runner.ts` and the `ForkForm` in `Drawer.tsx`.
- **Agent Redirect.** Drawer Redirect button enabled on a done/error agent with a captured session id. Resumes via `claude --resume <id>` (or `codex exec resume`), accepts a model/effort override per redirect. See `redirectAgent` + `runRedirect`.
- **Plan editing.** `PlanCard.tsx` has editable per-row text inputs, drop buttons, an "edited" badge, and a Spawn button that uses the user-tweaked rows rather than the Director's original proposal.

## Deferred features

Things that landed partially or are explicitly tabled. New sessions can pick from here when looking for the next slice.

- **Better attachments — text-only at v0.6.0.** Current code (`src/main/attachments.ts`) whitelists text/code extensions only (md / code / config / json / yaml), 100 KiB cap per file, inlined as fenced code blocks. Deferred:
  - **Image attachments** via Anthropic vision content blocks. The path is `claude --input-format stream-json` over stdin, sending a JSONL user message with `{type:'image',source:{type:'base64',media_type,data}}` content blocks alongside the text prompt — confirmed available on the CLI we now shell out to.
  - **PDF attachments** via `document` content blocks (same JSONL shape, different `type`).
  - **Larger caps for non-text** (Anthropic accepts up to 5 MiB per image; current 100 KiB cap is for inlined text).
  - **File picker filtered to supported types** instead of "all files + show error chip" UX.
  - **Drag-and-drop into the composer.**
- **Memory pins.** Drawer Memory tab still renders the "not wired up yet" placeholder. Skills already cover the "carry a persistent body of guidance into every turn" use case, so memory pins are lower priority than they were at v1.0.
- **Session-wide budget.** Per-agent budgets exist; a global "session won't exceed $X" cap (rolling across all agents in a session) doesn't.
- **Wipe session.** `wipeDirector` only clears the Director's chat. A full nuke — agents, log lines, attachments, settings.json `oauthToken` — for handing the machine off is still deferred.
- **More LLM providers.** *(Updated v0.5.x — Codex already shipped as a second provider.)* The runner now branches on a `provider` field per project (`claude` vs `codex`). Adding a third (GPT-5 via the standalone API, Gemini, open models) is feasible but needs:
  - A per-provider runner module that translates the structured event stream into the same `LogLine[]` shape the UI expects.
  - A re-implementation (or wrapping) of the Read / Write / Edit / Bash / Glob / Grep tool surface for providers that don't ship their own tool runner. Codex sidesteps this because `codex exec` has its own equivalent tool surface; a pure-API provider wouldn't.
  - Either keep the project-level provider pick (current shape) or add a per-agent provider field so the Director can stay on Claude while specialists run elsewhere. The per-agent variant is the most flexible and the least disruptive to add later.

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

### M1 — UI shell empty-state  *(completed 2026-05-15)*

- [x] Design tokens lifted from `docs/design/design-reference/styles.css` into CSS vars (mac traffic-light block dropped — we use native Electron chrome)
- [x] TopBar (38px), LeftRail (52px), StatusBar (24px)
- [x] Three panes: Director (resizable 300–640, default 400) / Agents (flex) / Drawer (resizable 340–680, default 460)
- [x] Draggable resize handles with accent-green hover glow + snap to min/max
- [x] Persist `dirW` and `drawerW` to localStorage (`orchestrator.dirW`, `orchestrator.drawerW` keys)
- [x] Empty states matching `docs/design/screenshots/empty-state.png` (Director "Awaiting your first task" + Drawer "No agent selected" + Agents "No agents running")
- [x] JetBrains Mono bundled as a webfont via `@fontsource/jetbrains-mono`, `tabular-nums` global
- [x] Rail nav items (Templates / Tools / Spend / Runs / Settings) route to a `PlaceholderScreen` ("coming in v1.1")

### M2 — Single-agent loop  *(completed 2026-05-15)*

- [x] Bypass Director temporarily: pick role + type task → spawn one SDK session in a fresh worktree
- [x] **Event classifier**: SDK stream events → `LogLine[]` with the design's 7 kinds. THOUGHT/TOOL/RESULT/WARN/ERROR/HANDOFF implemented; NOTE and proper HANDOFF meta-tools deferred to M3 (synthetic HANDOFF on `result` event for now)
- [x] Worktree lifecycle: create on spawn under `.orchestrator-worktrees/<name>` if target is a git repo; fall back to workspace itself otherwise. Pruning is a no-op for v1 — leave worktree for user to inspect / merge
- [x] Agent row in workspace pane with chevron expand → inline structured log streaming live
- [x] One running role end-to-end (coder, on auto-discovered Claude Code OAuth login)
- [x] Flex auth — supports Anthropic API key, explicit OAuth token, or auto-discovery from `~/.claude/` (Team plan users without API access work via Claude Code login)

### M3 — Drawer wired  *(completed 2026-05-15)*

- [x] Click agent → drawer opens, KPI strip (Step · Tokens · Cost · Elapsed) live
- [x] **Logs tab**: current task, spawner ("you · direct spawn"), last 8 log lines via shared `LogLineRow`
- [x] **Tools tab**: per-tool invocation count derived from `agent.log` + last-used `ts`; granted-but-unused tools shown with `0×` / `—`
- [x] **Context tab**: token total / 200k cap, percent bar. Per-segment breakdown deferred — requires plumbing model-side usage telemetry per turn
- [x] **Config tab**: system prompt (click-to-expand) + model + workspace + worktree path + placeholder budget/on-error fields
- [x] Action buttons: **Pause** (functional — aborts the SDK abort-controller). **Redirect** / **Fork** / **Approve** rendered but disabled with hover tooltips pointing at the milestone where each lands
- [x] **Spike result**: SDK exports `forkSession(sessionId)` (line 622 of sdk.d.ts) and `query({ options: { resume: sessionId } })`. Fork = `forkSession` → new session id → spawn new agent with that resume id + branched worktree. Feasible; defer the wiring to a M3.5 follow-up

### M4 — Director  *(completed 2026-05-15)*

- [x] Director system prompt (planner-supervisor role) in `src/main/director/prompt.ts`
- [x] Plan emission via **structured output** rather than MCP tool — Director outputs a fenced `orchestrator-plan` JSON block; UI auto-detects + renders a card. Same UX, far less plumbing for v1. Real MCP tools deferred.
- [x] Plan card with Accept button (no in-place editing in v1). On Accept the UI calls `pickWorkspace()` then `acceptPlan({ rows, workspace })`.
- [x] `acceptPlan` IPC spawns each row via the existing M2 runner with `spawnedBy: 'director'`; pushes a "Plan accepted. Spawned: …" message back to the Director session.
- [x] System messages render in the chat (`who: 'system'`, name in cyan)
- [x] HANDOFF flow: when a Director-spawned agent's `result` event fires, `director.notifyAgentDone(name, summary)` queues a `[handoff]` user message into the Director session — Director sees it on the next turn and replies.
- [x] Multi-turn via `query({ options: { resume: sessionId } })` — one Director session per app lifetime; message queue serialises user inputs and handoff notifications so we never overlap turns.

### M5 — Budgets + polish  *(completed 2026-05-15)*

- [x] Per-agent token + dollar meter, live (updates per assistant turn from `message.usage`)
- [x] Hard-stop on budget exceeded → status `error: Budget exceeded`. Caps for $ / tokens / wall-clock seconds, each independently configurable; 0 = unlimited
- [x] Per-turn NOTE log line showing input / output / cumulative / cost / current caps — surfaced the original bug where cached-prompt tokens were undercounted
- [x] Pulse animation on running / approval dots and streaming cursor on Director messages — landed in M2 + M4 CSS; verified
- [x] Session persistence — SQLite schema v2, write-through with 1s debounced flush, hydrate on startup. Director messages, agents, log lines, and the Director's SDK `session_id` all survive restart. Running agents at shutdown are flipped to `error: Interrupted` on next launch
- [ ] Memory pins via the SDK's memory tool — deferred to a future milestone; the memory tab still shows the "coming soon" placeholder. Not blocking for v1

### M6 — Installer + dogfood  *(completed 2026-05-15)*

- [x] Forge `MakerSquirrel` produces `Orchestrator-Setup.exe` (~204 MB; the bulk is Electron + the bundled 218 MB `claude.exe` deduped/compressed by Squirrel)
- [x] **asar disabled** — SDK's `child_process.spawn(claude.exe)` doesn't have asar-transparent path translation that `fs.*` does; files now live at `resources/app/` as plain JS
- [x] `afterCopy` hook plants `@anthropic-ai/claude-agent-sdk-win32-x64` + `sql.js` into the package's `node_modules` so externals resolve at runtime
- [x] Vite externals tuned: bundle most deps, leave only the SDK platform-binary packages and sql.js outside the bundle
- [x] Code signing deferred — SmartScreen warning is acceptable for self-install
- [x] Dogfood + tag v0.1.0 on main — shipped 2026-05-15. Post-v1 cadence picked up from there; see "Post-v1 highlights" below for what landed v0.2 – v0.6.

## Post-v1 highlights (v0.2 → v0.6)

Bundled here because the cadence ran roughly one minor every couple of days and the per-release detail lives in the curated annotated-tag bodies on GitHub.

- **Drop the bundled SDK; shell out to the user's `claude` CLI.** Was the architectural shift of v0.2. Killed the 218 MB installer bloat, the asar-can't-spawn-from-archive problem, and the entire native-binary distribution headache. We now drive the user's own login. (`a0676b8`)
- **Stream view.** Terminal-style live log for Director and agents, alongside the structured drawer. (`e3494fb`)
- **Real Spend screen.** Replaces the v1.1 placeholder. Daily cost chart over the last 30 days; per-turn `modelUsage` captured for true by-model accounting; "View official usage" deep-links to claude.ai. (`124293a`, `4ce11a0`, `ff7048d`, `dcbe8c1`)
- **Codex provider.** Projects pick `claude` or `codex` at creation; the runner branches on provider. Codex Fork is disabled (no `--json` on `codex fork`); ChatGPT-plan users skip `-m`; `gpt-5-codex` is the default model. Many small fixes followed (`cb9c977` and the trailing fix series).
- **Auto-update channel.** `update-electron-app` polling `update.electronjs.org` every 10 min. The privacy flip on 2026-05-17 made this actually work — `update.electronjs.org` doesn't serve private repos.
- **Slash commands in the Director composer** (Tier 2). (`f5fec48`)
- **Per-role skills + new `security` role.** Each role can opt into a skill slot; security audits code for vulns / leaked secrets / unsafe patterns. (`327ace4`)
- **Director skill slot.** v0.6.0. Director itself can now have a skill, mirroring per-agent slots. (`dbb9360`)
- **Provider-aware CLI install gate.** Project creation only allows providers whose CLI is installed and logged in. (`f184e62`)
- **ASAR integrity-fuse reversal.** v0.4.0 tried turning the fuses on — silent install failure. Reverted; fuses stay off until the integrity-hash flow is verified end-to-end. (`0a61b6b`)
- **Release-notes workflow fix.** `actions/checkout` now fetches tag objects so curated annotated-tag bodies show up on the GitHub Release without a manual `gh release edit`. **v0.7.0 will be the first end-to-end test.** A `Write-Host` diagnostic in `release.yml` is there for debugging if it doesn't render.
- **Going public.** Personal identifiers scrubbed from history; repo flipped public on 2026-05-17.

## Hardest unknowns (spike when their milestone arrives)

1. **Event classifier (M2)** — Resolved. Synthetic HANDOFF on `result` event; NOTE deferred (no `pin_note` meta-tool in v1).
2. **Fork semantics (M3.5)** — Resolved by spike. SDK exposes `forkSession(sessionId)` + `query({ options: { resume } })`. Wiring deferred but the API is there.
3. **Plan card I/O (M4)** — Resolved via structured-output JSON block (`orchestrator-plan`) parsed in main, instead of an MCP tool call. Simpler.
4. **HANDOFF (M4)** — Resolved. Agent's `result` event triggers `director.notifyAgentDone()` which queues a `[handoff]` user message into the Director session.
5. **Redirect (M5+)** — Director can't inject instructions into an already-running agent. Each spawned agent is one-shot — it commits to its initial task. The SDK's `Query.streamInput()` (sdk.d.ts:2248) might be the path; needs a spike. Workaround for now: write self-contained task lines, or use manual mode for tighter per-agent control.

## References

- Design handoff (read this before any UI work): [`docs/design/README.md`](./docs/design/README.md)
- Screenshots: `docs/design/screenshots/`
- React + CSS reference: `docs/design/design-reference/`
- Sibling project (release-workflow patterns to mirror): `D:\ClaudeCode\KnittingApp`

## v1 milestone log (2026-05-15)

The original v1 push was a single-day blitz; the per-milestone deep-dives below are kept for historical context. For everything since, see "Post-v1 highlights" above.

- **2026-05-15 — M6 Installer.** `npm run make` produces a working `Orchestrator-Setup.exe` from Forge's MakerSquirrel. Real fight was the SDK's bundled `claude.exe`: bundling a 218 MB native binary isn't possible, externalising it puts it in `node_modules` at runtime — but Forge's plugin-vite strips `node_modules` from the package, so a custom `afterCopy` hook plants the SDK platform-binary package + `sql.js` (UMD wrapper doesn't survive Rollup bundling) back into the build. Then asar.unpack vs spawn() turned out to be a known Electron gotcha: `fs.existsSync` is asar-transparent but `spawn` isn't, so even with unpack the SDK got "exists but failed to launch". Final shape: drop asar entirely, files live at `resources/app/`, real filesystem paths everywhere. Installer is 204 MB, install + spawn verified.
- **2026-05-15 — M5 Budgets + persistence.** Per-agent budgets (dollars, tokens, wall-clock) with hard-stop on the runner side: tokens accumulate from each assistant message's `message.usage` (now also counting `cache_creation_input_tokens` + `cache_read_input_tokens` — the original miss that hid all the cached input on Sonnet runs). Spawn form has optional inputs; Drawer Config tab shows live progress bars. Session persistence via SQLite schema v2: Director chat, agents, log lines, and the Director's resumable SDK session id all write through on every event (debounced flush) and rehydrate on startup. In-flight agents at shutdown get flipped to `error: Interrupted`. Per-turn NOTE log line is kept as a feature, not just debug — useful to watch spend in real time. Memory pins deferred (not blocking for v1).
- **2026-05-15 — M4 Director.** Plan emission via structured-output (`orchestrator-plan` fenced JSON block, parsed in main, rendered as a card) rather than real MCP tools — same UX, far less plumbing. Multi-turn via `query({ options: { resume } })`. Single-turn-at-a-time queue serialises user inputs and `[handoff]` notifications from agent completions, so the Director actually supervises a run. **Bypass mode** (no Accept click) + **workspace pill** in the top bar landed shortly after for friction reduction.
- **2026-05-15 — M4 follow-ups.**
  - **Mode toggle** in the Director header — `auto` (current — plans + auto-spawns) vs `manual` (advisor — prose only, no plan blocks). Mode persists to localStorage. Each user message is tagged `[mode: X]` so the Director sees it without restarting the session. Director system prompt explains both modes; manual-mode response is verified to give phase-structured prose advice with concrete agent counts + risk flags + an explicit nudge back to manual control.
  - **Sequential auto-spawn** — agents now run in plan order, one at a time. `spawnAgent` registers a completion `Promise<void>` in a Map; new `awaitCompletion(id)` lets `acceptPlan` chain rows. Fixed the bug where pm/coder/qa all started simultaneously and qa "verified" before coder had touched a file.
  - **Director prompt update**: task lines must be self-contained (agents are one-shot, can't be redirected mid-flight). Real `Redirect` is deferred to a later milestone — see Hardest unknowns.
- **2026-05-15 — M3 Drawer wired.** Click an agent → live drawer with role-tinted sigil, KPI strip (Step / Tokens / Cost / Elapsed updating each second), and five tabs. Logs tab tails the last 8 lines, Tools tab derives invocation counts + last-used from `agent.log`, Context tab shows a tokens-vs-200k-cap bar, Config tab has the click-to-expand system prompt + model + workspace + worktree path. Pause action functional (aborts the AbortController). Redirect / Fork / Approve disabled with hover tooltips pointing at the milestone where each lands. Moved `roles.ts` to `shared/` so renderer can read it. Fork spike: SDK has `forkSession()` + `resume` option — deferred to M3.5.
- **2026-05-15 — M2 Single-agent loop.** Wired the Claude Agent SDK (which ships a 218MB `claude.exe` and is loaded via dynamic ESM import from our CJS main). Per-agent git worktree, event classifier mapping SDK stream → 7 LogLine kinds, IPC streaming (agent/log/patch channels), useAgents hook + AgentRow + LogLineRow + SpawnAgentForm modal. Flex auth so Team-plan users without API access can run via auto-discovered Claude Code OAuth. End-to-end smoke verified (coder spawned, THOUGHT + HANDOFF rendered live).
- **2026-05-15 — M1 UI shell empty-state.** React + Vite plugin wired, full design CSS lifted verbatim (minus mac traffic lights). Component tree under `src/renderer/components/`: TopBar, LeftRail, StatusBar, DirectorPane (+ EmptyChat + Composer), AgentsPane (+ EmptyAgents), Drawer (no-selection state), ResizeHandle, Icon, PlaceholderScreen. Resize widths persist via `useLocalStorageState`. Rail items route between the home orchestrator screen and v1.1 placeholders.
- **2026-05-15 — M0 Skeleton.** Forge scaffold reorganised into four-pane src layout. Typed IPC bridge proves end-to-end. sql.js stood in for better-sqlite3 (no native compile toolchain). Window opens on `--ink` background, first commit on `main`, working branch `dev` pushed.
