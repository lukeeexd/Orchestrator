# `docs/product/feature-proposals.md`

> Senior-PM review of Orchestrator as of `v0.15.1` (read against `PLAN.md`, `BACKLOG.md`, `README.md`, `docs/design/README.md` and the `src/` tree on 2026-05-21). This is a planning artefact — no source code is modified by this proposal.

## 1. Product summary

Orchestrator is a Windows desktop app (Electron + React + TypeScript, `package.json` v0.15.1) that turns the user's locally-installed `claude` and/or `codex` CLI into a director-led multi-agent workflow. An LLM **Director** session (`src/main/director/runner.ts`, prompt in `src/main/director/prompt.ts`) chats with the user and emits fenced `orchestrator-plan` / `orchestrator-prd` / `orchestrator-redirect` JSON blocks (parsed in `src/main/director/parse.ts`), which the renderer renders as a `PlanCard` / `PRDCard` (`src/renderer/components/PlanCard.tsx`, `PRDCard.tsx`). When the user accepts a plan, the runner sequentially spawns specialised agents — pm, researcher, coder, qa, devops, security — each with a role-specific system prompt and tool allow-list (`src/shared/roles.ts`), per-agent budget in $/tokens/seconds, optional flavour (e.g. `qa.playwright`), and optional MCP servers (`src/main/mcpScaffold.ts`). Live drawer streams every step, a structured handoff payload (`src/main/agents/handoffPayload.ts`) flows from agent → Director, and the app aggregates lifetime / 7d / 30d spend (`src/main/spend.ts`, `SpendScreen.tsx`) and surfaces rule-based optimisation cards (`src/main/spendRecommendations.ts`). A skill **Marketplace** (`src/main/marketplace/*`) lets users subscribe to vetted skill bundles with a path-traversal auditor (`src/main/skillAudit.ts`); **Templates** (`src/main/templates.ts`) persist reusable plans; local-only **crash capture** (`src/main/crashes.ts`) writes JSON forensics to `userData/crashes/`; **auto-update** runs against a Cloudflare R2 Squirrel feed with a Pages-hosted secondary signal channel (`src/main/updater.ts`, `secondaryUpdater.ts`).

## 2. Proposed features

### Theme — UX polish

**F1. ~~Director command palette (Ctrl/⌘-K).~~ — shipped 2026-05-23.**
- New `CommandPalette.tsx` overlay mounted in App. Ctrl/⌘-K toggles open; Up/Down navigate; Enter runs; Esc closes. Fires even while typing in the composer (palette is the global navigation surface). Action source is the existing `BUILTIN_COMMANDS` list; the slash-menu switch was extracted into a shared `runBuiltinAction` callback so the palette and the slash menu invoke the same code path. Added `go-marketplace` and `go-docs` to the action enum so the palette covers every rail item.

**F2. Inline plan diff / "what changed" between two Director plans.**
- **Problem:** when the Director re-plans (user edits the prompt, asks for revisions), the new PlanCard replaces the old one — there's no visible diff of which rows were added, removed, or had their tasks rewritten. Reviewers approve plans blind.
- **Scope:** **S/M**. Renderer-only diff between consecutive `plan?: PlanRow[]` payloads on `DirectorMessage` (see `src/shared/types.ts:264`).
- **Impact:** **medium-high** — directly de-risks the "auto mode spawned 6 agents I didn't expect" failure mode `App.tsx:439` calls out.
- **Deps/risks:** none; pure rendering. Risk = ambiguity when row names are reused — match on `i` index first, fall back to name.

**F3. ~~Render PRDCard in classic chat view~~ — shipped 2026-05-22.**
- Shipped via `R-H1` in commit `56c0350` (review-findings Cluster 1). `DirectorPane.Message` now renders `message.prd` paralleling the existing `plan` / `redirect` branches. Kept here as a retirement marker so the F-numbering stays stable.

### Theme — Power-user / productivity

**F4. Parallel-lane agent execution (opt-in fan-out).**
- **Problem:** the runner is deliberately sequential (PLAN.md "Per-agent isolation" decision). For embarrassingly-parallel work — "audit these six independent modules", "write tests for each handler" — users wait n× longer than necessary.
- **Scope:** **L**. Needs a `parallelGroup` field on `PlanRow` (`src/shared/types.ts:180`), a fan-out scheduler in `src/main/agents/spawn.ts`, a per-row worktree (resurrects P13 path c from BACKLOG), and a renderer change to render swimlanes in `AgentsPane`.
- **Impact:** **high** — biggest wall-clock win available without changing what the app does.
- **Deps/risks:** the M4 reason for dropping worktrees (shared workspace for sequential artefact flow) is real; safest path is a "parallel group" boundary inside a single plan that all converge before the next sequential row. **Spike outcome (2026-05-25):** `claude --resume` does NOT tolerate a cwd change — sessions are stored under `~/.claude/projects/<encoded-cwd>/`. All three paths (a/b/c) from the original spike doc are dead in their current shape. **A2 (workspace as interface) is now a genuine prerequisite** so the runner can express "this agent's worktree path AND its CLI session pool path" without leaking the cwd constraint into every redirect / fork. See `docs/spike-2026-05-21-per-agent-worktrees.md`.

**F5. ~~"Rewind Director to turn N" / branching conversations.~~ — shipped 2026-05-25.**
- **Problem:** Director chats drift; the only reset was `wipeDirector` (`App.tsx`) which nukes everything. Users want to fork from a known-good point and try a different prompt.
- **Shipped:** `persistence.rewindDirectorMessagesTo(projectId, messageId)` truncates `director_messages` past the anchor's `ordering`, appends a `director.rewind` event, and `DirectorSession.rewindTo` aborts in-flight, slices in-memory messages, clears `session_id` + queue + busy. New `DirectorRewind` IPC + preload binding. Both `DirectorPane.Chat` and `DirectorStream` show a hover-revealed "rewind" affordance on every non-live, non-last message. Caller `await`s the IPC then calls `useDirector.refresh()` — explicit re-fetch over the broadcast-clear path to avoid an empty-state flash.
- **Trade-off accepted:** Clearing `session_id` after truncate means the next turn starts a *fresh* claude session (no `--resume`), sidestepping the open question of whether `claude --resume` tolerates a truncated history. Cheaper than a session reseat and behaviourally equivalent for the user.

**F6. ~~Project-scoped secrets / env vault.~~ — shipped 2026-05-23.**
- New `project_secrets` table via migration v24 (composite PK on `project_id, name`); `src/main/secrets.ts` handles list / set / delete / reveal + a main-only `getSecretsForSpawn` helper; `buildEnv` in `agents/internal.ts` layers project secrets onto the spawn env so the agent's shell sees `$DATABASE_URL` / `$GH_TOKEN` / etc. as regular env vars — never appearing in prompt, log, or crash bundle. Project secrets win over inherited `process.env` of the same name.
- New **Secrets** tab in `ToolsScreen` lets users add / edit / delete entries. List shows metadata only (`name`, length, updated-at) — values cross the IPC boundary one-at-a-time via a `revealSecret` round-trip. Names must match the env-var convention `^[A-Z][A-Z0-9_]{0,62}$`; 8 unit tests cover the regex + assertion path.
- **Storage decision deliberately plaintext for v1**, matching the existing OAuth-token-in-settings.json precedent. NTFS ACLs already gate other users on the same machine. DPAPI encryption is the natural follow-up if Orchestrator ever ships to multi-user shared hosts.

**F7. Pre-spawn cost forecast on PlanCard.**
- **Problem:** users approve a 6-agent plan without any sense of whether it'll cost $0.30 or $30. The data needed is already collected per-role + per-model in `getSpendSummary` (`src/main/spend.ts`).
- **Scope:** **S**. Compute a historical median $/role + adjustment for task-length and model selection; render an estimate chip on `PlanCard.tsx`'s spawn button (currently "Spawn N" / "Spawn N + 2", see P5).
- **Impact:** **medium-high** — the most common request from anyone who's been burned by an Opus run.
- **Deps/risks:** new users with no history get a wide CI; mitigate with "first run — no data" placeholder.

### Theme — Observability / telemetry

**F8. ~~Run timeline / Gantt visualisation.~~ — shipped 2026-05-24.**
- HistoryScreen gains a `list / timeline` toggle in its pane head; the timeline view renders the filtered rows as a Gantt chart with proportional bars over wall-clock time (label column + time-axis ticks + colour-by-status). Sequential chains show their gaps visibly; running agents extend to "now" with a dashed border.
- New `ended_at INTEGER` column via migration v25 + best-effort backfill from `started_at + parse(elapsed)` for existing rows. `registry.patch` auto-stamps `endedAt = Date.now()` on every transition to a terminal status (`done` / `error` / `paused`) so callers don't have to remember. Three pre-existing crash patches in `spawn.ts` / `fork.ts` / `redirect.ts` were also routed through `registry.patch` (they were only notifying the renderer, leaving the DB row in `running` — fixed in the same pass).

**F9. Crash → shareable bundle.**
- **Problem:** today the user has to open `userData/crashes/`, find the right JSON, copy it, scrub anything sensitive, and attach to a bug report. Friction kills crash submissions.
- **Scope:** **S**. Existing `crashes.ts` already lists entries. Add an "Export as .zip" button in `SettingsScreen.tsx` that bundles the JSON + the last 200 log lines from `agents` for active projects + the last 50 Director messages, with an opt-in secret-scrubber pass.
- **Impact:** **medium** — small effort, helps every future bug.
- **Deps/risks:** scrubber must not be lossy enough to obscure the actual crash; risk of false-positive redaction in stack traces.

**F10. ~~Live context-window meter chip per agent.~~ — shipped 2026-05-23.**
- New `ctx` KPI chip on AgentRow shows the agent's cumulative tokens as a percentage of the model's known context cap. Colours: <50% muted, 50-80% amber, ≥80% red. Tooltip explains that cumulative is an upper-bound proxy (the per-turn payload is what actually counts against the cap; a future refactor could record per-turn input tokens specifically). Unknown models (or codex agents whose CLI doesn't expose usage) show `—` rather than faking a number. Context sizes live in a new `MODEL_CONTEXT_TOKENS` table in `src/shared/models.ts`.

### Theme — Collaboration / handoff

**F11. ~~Run-bundle export (portable `.orun`).~~ — shipped 2026-05-25.**
- New `RunsExportBundle` IPC + `src/main/runBundle.ts` slices the A1 events table for the requested agents + UNIONs the project's `director.*` events, fetches the projection-table state for each agent, fetches the project's Director messages, and writes the lot to a `.orun` zip under `userData/exports/`. Bundle contents: `manifest.json` (versions, agent count, scrub flag) + `events.json` (the full event slice) + `agents.json` (final projection state with model_usage) + `director-messages.json` + `logs/<agentId>.log` per agent.
- UI affordance: per-row paperclip icon in HistoryScreen alongside the template / changelog / recap buttons; pane head has a "scrub on export" toggle (default on) + an inline "Export failed" notice when it errors. Single-row export is v1; the underlying IPC already accepts an array so multi-select is a follow-up.
- Reuses F9's secret-scrubber — extracted to `src/main/secretScrubber.ts` so both surfaces share one pattern set. The A7 re-cost the architect flagged (heuristic handoff-payload as public contract) **is moot now**: A1 Lite gave us real persisted events to slice, so no heuristic is involved.

**F12. ~~Comments / sticky notes pinned on log lines.~~ — shipped 2026-05-24.**
- New `log_notes` table via migration v26, composite PK on `(agent_id, line_key)`. `line_key` is the FNV-1a-32 hex of `ts + kind + msg-serialised` (with tool-call args sorted) — pure JS in `src/shared/logNotes.ts` so the renderer can compute keys without crossing the IPC boundary. The hash beats indexing by `seq` because it survives any future log replay / reorder, and a back-edit of a log line (which doesn't currently happen) would orphan its note rather than mis-attribute.
- Notes are authored from the Drawer's Logs tab — a hover affordance on each line opens an inline textarea with Ctrl-Enter save / Esc cancel / "save empty = delete." `useLogNotes(agentId)` does an optimistic in-memory update before the IPC round-trip so saves feel instant; failures roll back via a re-fetch. AgentRow's rail expansion deliberately doesn't get the affordance — the Drawer is the deeper-read surface where annotation belongs.
- `deleteNotesForAgent` is called from the agent-remove path so the table doesn't accumulate orphans. 7 unit tests cover the line-key hash (determinism, ts/kind/msg sensitivity, arg-order invariance for tool calls).

### Theme — Platform / monetisation

**F13. Provider plug-in surface (Gemini, Ollama, generic OpenAI-compatible).**
- **Problem:** `Provider` is hardcoded `'claude' | 'codex'` (`src/shared/types.ts:57`). Each project picks one at creation. PLAN.md notes a third provider is "on the table". Users with Gemini Pro / a local Ollama box / OpenRouter credit are locked out.
- **Scope:** **L**. Define a `ProviderRunner` interface (probe + spawn + parse-events) and extract `cli/spawn.ts` (claude) + `cli/codex.ts` into implementations. New providers register via a manifest in `userData/providers/`.
- **Impact:** **high** — opens addressable user base; lets users pin cheap providers to PM/researcher roles.
- **Deps/risks:** event normalisation across CLIs is the same kind of work that codex onboarding already paid for, but each new provider has its own tool-allowlist semantics (codex uses sandbox-policy scopes — see `src/shared/types.ts:90`). Codex Fork is already disabled for this reason; expect more such carve-outs.

**F14. Git integration: auto-branch per accepted plan — partial: auto-branch shipped 2026-05-26; auto-PR deferred.**
- **Problem:** every accepted plan produced unscoped changes on whatever branch the user happened to be on. The user had to manually `git checkout -b ...` before spawning.
- **Shipped (auto-branch half):** per-project `autoBranch` toggle (migration v28 adds `projects.auto_branch INTEGER`). The Director header gets a branch-icon toggle button next to the model picker. When on AND the workspace is a git repo, `DirectorAcceptPlan` calls `ensureBranch(workspace, 'orchestrator/<planId:8>-<slug>')` before the first agent spawns — a Director system message records whether it created, reused, or skipped the branch. `slug` is derived from the first plan row's task. Re-accepting the same plan re-uses the same branch (idempotent).
- **Skip policy:** silent skip when the workspace isn't a git repo (most setups). Surfaced-in-chat skip when uncommitted changes exist (refuses to switch branches and carry edits silently) or the plan id is missing (older renderer). Git operations are 5s-timeout `spawnSync` calls in `src/main/git.ts` — dependency-free leaf module, 9 unit tests on the pure helpers (`slugify`, `buildBranchName`).
- **Deferred — auto-PR half:** user explicitly chose "auto-branch only — skip PR entirely for now" (2026-05-26). Manual `gh pr create` remains the path. Revisit if the "described → PR" loop still feels broken in practice.

**F15. Cross-platform builds (macOS / Linux).**
- **Problem:** README + PLAN both lock to Windows. The only Windows-specific code is `MakerSquirrel` and the R2 update path. The CLI dependency is platform-agnostic; users on Mac/Linux are excluded by packaging, not by design.
- **Scope:** **L**. New Forge makers (`MakerDMG`, `MakerDeb`), CI matrix in `.github/workflows/release.yml`, code-signing notarisation for macOS (Apple Developer ID), per-platform auto-update channel.
- **Impact:** **high** — biggest reach unlock; pairs with H7 code signing (already deferred).
- **Deps/risks:** macOS notarisation requires a paid Apple Developer account; signed-installer item is already a known blocker (H7). DPAPI in F6 needs a per-OS replacement (libsecret / Keychain).

**F16. ~~Claude Code memory bridge.~~ — shipped 2026-05-22.**
- Surfaces the per-project memories Claude Code accumulates (under `~/.claude/projects/<encoded>/memory/`) into Orchestrator's agent prompts. `effectiveSkill()` reads the project's MEMORY.md index, walks each linked file, and includes only `project` and `reference` types — `user` and `feedback` types are skipped because they're about the user / about the assistant rather than about the codebase. No-op when the directory doesn't exist (user hasn't used Claude Code on this project). Source: `src/main/claudeCodeMemory.ts` + composed into `effectiveSkill` in `skills.ts`. Pure helpers covered by 14 new unit tests.
- Privacy / scope decision: silent inclusion (no Settings toggle) because Orchestrator is a single-user app and the only memories that flow through are codebase-scoped (`project` + `reference`). If a user wants to opt out, deleting MEMORY.md or removing the type frontmatter on individual files achieves it without code changes.

## 3. Quick wins (top 3, high-impact / low-effort)

1. ~~**F3 — PRDCard in DirectorPane** (XS).~~ Shipped 2026-05-22 (see retirement note above).
2. ~~**F7 — Cost forecast on PlanCard** (S).~~ Shipped 2026-05-22. Per-role median cost from completed agents, ±50% band, chip on the spawn button. Source: `src/main/spendForecast.ts` + `IpcChannels.SpendForecastPlan`.
3. ~~**F9 — Crash → shareable .zip** (S).~~ Shipped 2026-05-22. `exportCrashBundle` in `src/main/crashes.ts` writes a zip containing the crash JSON + recent Director messages + recent agents + per-agent log tails, with an opt-in secret-scrubber. Button lives in `SettingsScreen.tsx`'s Crashes section.

## 4. Bold bets (top 2, high-impact / large-effort)

1. **F4 — Parallel-lane execution.** This is the single feature that changes what Orchestrator *is* — from a sequential pipeline into a real fleet. Worth the worktree spike (PLAN.md P13 path c), the schema change, and the swimlane UI because no other feature multiplies wall-clock value the same way.
2. **F13 — Provider plug-in surface.** Moves the codebase from "claude-then-codex bolt-on" to a real abstraction. Unlocks Gemini / Ollama / OpenRouter without a fork. Pairs naturally with F6 (per-provider secret slot) and F15 (cross-platform) for a clean 1.0 narrative.

---

**Notes for the executing agent:**
- F3 retired 2026-05-22 (shipped via R-H1 in commit `56c0350`).
- F4 is hard-blocked on the `claude --resume` cwd-tolerance experiment in `docs/spike-2026-05-21-per-agent-worktrees.md`; don't sequence it ahead of that spike.
- F14 (auto-PR) should sequence **after** F4 to avoid building on a workspace model that's about to change.

## Architect's lens

Senior-architect pass over the same code-base + the PM's proposals on 2026-05-21. Five entries below add capabilities the PM under-weighted because they reshape abstractions rather than UI; two re-cost PM features that the proposal undersells. Each entry cites the files that would actually move.

**A1. Event-source the agent run — partial: dual-write Lite shipped 2026-05-24.**
- The Lite version landed: new `events` table via migration v27 (`seq INTEGER PRIMARY KEY, project_id, agent_id, ts, kind, body, schema_v`). Every state-changing persistence operation now appends a row alongside its existing INSERT/UPDATE on the projection tables. Existing tables stay PRIMARY — `events` is an additive audit trail. Kinds enum + reader live at `src/shared/events.ts` + `src/main/events.ts`; wired sites cover agent.spawn / patch / log / delete + director.message / wipe + note.set / delete. Best-effort writer never throws (a corrupt audit row can't block the user-visible write).
- Reserved-but-not-yet-wired kinds: `agent.handoff` / `agent.redirect` / `agent.fork` / `director.message_patch` / `director.plan_accepted`. These are derivable today from the wired kinds (e.g. fork = spawn-with-forkedFromId; handoff = patch with status=done + the final log line) so wiring them is a follow-up when F11 / F5 actually need them.
- **Full A1 — events as source of truth, projections rebuildable — is the future follow-up.** That's where F4 (parallel lanes as interleaved events), F5 (rewind = `events.where(ts < cutoff)`), F11 (run-bundle = event slice + manifest), and the cleaner version of F12 (notes as a `note` event kind, projection-rebuildable) actually fall out. The Lite version unblocks all of them in their current shape without the migration risk of rebuilding projections from events.

**A2. Workspace as an interface, not a string (capability gap + reshape).**
- `Project.workspace` is a path string (`src/shared/types.ts:62`). Every spawn cwds into it (`src/main/cli/spawn.ts`), and the M4 "per-agent isolation = none" decision (PLAN.md, "Decisions locked") is locked in *because* the abstraction is too thin to express anything else.
- A `Workspace` interface with `.cwd() / .branch() / .merge() / .snapshot()` lets workspaces be: local folder (today), git-worktree (P13 path c), ephemeral copy-on-write dir, remote SSH host, ephemeral container. F4 and F14 both pile onto the string-path assumption — the abstraction unblocks both cleanly and is the right place to revisit M4.
- **Capability gap the PM missed entirely: remote / containerised workspaces.** Once the abstraction exists, an SSH-backed workspace is one implementation — "run agents against my staging box" without installing `claude` there. Pairs naturally with A5 (telemetry) for fleet visibility.
- **Promoted to F4 / F14 prerequisite (2026-05-25).** The resume-cwd spike confirmed `claude --resume` is strictly cwd-scoped, so any per-worktree feature needs the workspace abstraction to express "session pool path AND cwd path" together. F4 / F14 can't be built on today's `string` directly.

**A3. ~~Headless / scriptable engine mode (the missing surface).~~ — shipped 2026-05-26.**
- **Was:** Orchestrator was GUI-only. The entire IPC surface was reachable only through Electron's `contextBridge`; no stdio, no HTTP, no scriptable entry. `src/main/index.ts` booted a `BrowserWindow` unconditionally.
- **Shipped:** `Orchestrator.exe --headless` boots the main process without a window and speaks newline-delimited JSON-RPC on stdin/stdout. Request `{id, channel, args}` → response `{type:'response', id, ok, result|error}`; broadcast events (agent logs, director messages) stream out as `{type:'event', channel, payload}`; a one-time `{type:'ready', channels:[...]}` advertises the callable surface. Every existing IPC channel (~90) is scriptable — no per-handler rewrite.
- **How:** `src/main/ipc/dispatch.ts` captures handlers by wrapping `ipcMain.handle` for the duration of `registerIpcHandlers({capture:true})` (try/finally restore; GUI boots skip it and stay byte-identical). `broadcast` gained a swappable emit sink (`setEmitSink`) so events route to stdout in headless. `src/main/headless.ts` runs the stdio loop. Single-instance lock still applies — headless refuses to start while a GUI instance holds the userData/db lock (prevents sql.js corruption), reporting the conflict on stderr.
- **Windows gotcha (verified):** a packaged Electron app is a GUI-subsystem binary whose `process.stdin` never initialises — stdout works (so `ready` prints) but no stdin `data` ever fires. Fixed by reading fd 0 via `fs.createReadStream('', {fd:0})` instead of `process.stdin`. Confirmed end-to-end against the packaged exe: `app:ping`, `project:list`, and an unknown-channel error all round-tripped correctly.
- **Deferred:** a friendly `run --template <id>` subcommand and HTTP transport. The raw stdio JSON-RPC surface is the full input story; nicer wrappers can layer on top.

**A4. First-class extensibility surface — provider + role + tool registries (capability gap).**
- `Provider` is a `'claude' | 'codex'` union (`src/shared/types.ts:57`). Roles are a hardcoded six in `src/shared/roles.ts`. Tool allow-lists are per-role defaults overridden per-project (`projects.role_tools`, `src/main/db.ts:177`). The skill marketplace (`src/main/marketplace/*`, db v16-v19) extends only *prompt content*.
- PM's F13 covers the provider axis but misses the other two. A symmetric `RoleRegistry` + `ToolRegistry` (manifest-driven, discoverable from `userData/extensions/`) lets a bundle ship **new roles**, **new tools**, and **new providers** through one mechanism — what a real plugin system looks like.
- Capability gap (a): today an author who wants to ship a `data-engineer` role or an `openrouter` provider has nowhere to put it. Composes with A3 (headless): registered extensions surface in scripted runs without any UI work.

**A5. Outgoing telemetry / webhook bus (capability gap).**
- Telemetry is **inbound and local-only**: crash JSON to disk (`src/main/crashes.ts`), spend recomputed from DB (`src/main/spend.ts`), skill fires in `skill_fire_counts` (`src/main/db.ts:312-324`). Nothing leaves the machine.
- A pluggable outgoing event sink — OTLP exporter, generic webhook, optional file tail — lets Orchestrator integrate with the user's existing observability (Datadog, Slack, GitHub Issues, custom dashboards). PM's F8 (Gantt) and F9 (crash bundle) both address *internal* observability and ignore the integration story.
- Cleanly bolts onto A1: each persisted event is one publish. Capability gap (a) the PM didn't name because it requires seeing the codebase as a system that should emit, not just record.

**A6. Re-cost of F4 (parallel-lane): closer to XL than L (architecturally expensive).**
- PM scopes F4 as L. The hidden depth:
  - `src/main/agents/agent-lock.ts` serialises completions; parallel groups need re-entrancy.
  - `src/main/director/runner.ts` queues handoffs as a single stream; the "previous agent finished before next starts" invariant the handoff aggregator assumes (`handoffPayload.ts`) breaks under fan-out.
  - DB has no parallel-group concept (`src/main/db.ts:37-57` agents table) — needs a `parallel_group_id` column and convergence semantics.
  - The drawer is single-active-agent shaped today; swimlanes are a renderer rebuild, not a tweak.
  - Codex Fork is already disabled for a related sequencing reason (PLAN.md "Providers"); parallel codex lanes need their own carve-out.
- **Without A1 (event-source) and A2 (workspace interface) under it, F4 becomes a tangle of point fixes across five files.** With them, it is "a scheduler + a swimlane component." Sequence A1 → A2 → F4. Don't take it standalone.

**A7. Re-cost of F11 (run-bundle export): the schema-version trap (architecturally expensive).**
- PM scopes F11 as M. Hidden cost: handoff payloads aren't persisted as rows — they're rebuilt on demand in `src/main/agents/handoffPayload.ts:23-34` from log heuristics. Exporting requires either (a) persisting payloads (new column/table + a migration that can't backfill cleanly because old logs may not parse), or (b) freezing the heuristic parser at v1 forever and shipping bug-compat code for every future log change.
- Plus: the `.orun` manifest becomes a **public contract** the moment a second machine reads one. Schema versioning, forward-compat, "this bundle is from a newer Orchestrator" UX — all the standard evolution headaches. `src/main/db.ts:444-459` migrations are forward-only by design; the export format inherits that.
- **Do not ship F11 before A1.** Persisted events make `.orun` a trivial event-slice + a manifest pointer; the rebuild-from-heuristics trap vanishes.

---

**Sequencing the architect's lens against the PM's list:**

1. A1 (event-source) first — unblocks F4 / F5 / F8 / F11 / F12 and de-risks A5.
2. A2 (workspace interface) — re-opens the M4 isolation decision cleanly; unblocks F4 / F14.
3. A3 (headless) + A4 (extensibility registries) can ship in parallel; both are additive.
4. A5 (outgoing telemetry) bolts onto A1 once it lands.
5. F4 and F11 sit *after* A1/A2; their PM scopes are accurate only with the abstractions in place.
6. ~~PM's quick wins (F3, F7, F9)~~ — all three shipped 2026-05-22 (independent of the abstractions above).