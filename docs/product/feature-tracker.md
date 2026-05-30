# Feature & QOL tracker

Living status board for every idea from the competitive sweep
([`competitive-research-2026-05-29.md`](./competitive-research-2026-05-29.md)),
plus quality-of-life items. The research doc holds the **full detail + verifier
caveats** per feature; this file is the lightweight **progress layer** — one row
per item, updated as work moves.

Older roadmap items (F1–F15, A1–A7, P-items, code-review R-items) live in
[`../../BACKLOG.md`](../../BACKLOG.md); this tracker cross-references them where
they're dependencies (A1, A2, F4, F2, P11.1).

## Status legend

- `[ ]` **idea** — captured, not yet scoped
- `[~]` **scoped** — concrete plan, ready to start
- `[>]` **building** — in progress (link the branch)
- `[x]` **shipped** — note the version
- `[-]` **rejected / skip** — with a one-line reason

**Tier:** `quick-win` · `strategic` · `bold-bet` · `skip`. **Effort:** S / M / L / XL.
✅ = clean `recommend` verdict from the verifier. ⚠️ = framing depends on the
cost/budget/context surface removed in v0.24.0 (treat as a *re-introduction*).

---

## ★ Priorities (the curated shortlist)

The highest value-per-effort, no-blocker starting points. Detail in research §2/§4.

### Quick wins (ship-now, no blockers)
| ID | Feature | Effort | Status |
|----|---------|--------|--------|
| N8 | Pre-acceptance clarifying-questions round-trip | S | `[x]` v0.37.0 |
| N9 | Plan confidence + driving ambiguities | S | `[x]` v0.39.0 |
| N34 | Off-device push when blocked / done | M | `[ ]` |
| N18 | Segmented context breakdown card ⚠️ | S | `[x]` v0.38.0 |

### Clean recommends + strategic spine
| ID | Feature | Effort | Status |
|----|---------|--------|--------|
| N7 ✅ | Plan Critic (adversarial pre-spawn plan review) | M | `[x]` v0.36.0 |
| N21 ✅ | Per-row file-path edit allow-list (PreToolUse deny) | M | `[ ]` |
| N19 ✅ | Per-row plan-approval gate (read-only → unlock writes) | L | `[ ]` |
| N3 | Deterministic row-transition gates (shell + stderr) | M | `[x]` v0.41.0 |
| N1 | Deterministic done-gate (run-until-green + re-route) | L | `[ ]` |
| N2 | Regression-aware verification (fail/pass-to-pass) | L | `[ ]` |
| N11 | Multi-lens review fan-out | M | `[ ]` |
| G1 | Repo code-graph index (grounds planning + review) | L | `[ ]` |

---

## Cross-cutting prerequisites (decide deliberately)

These keep recurring as blockers/dependencies — worth a deliberate call before the items that lean on them.

| ID | Prerequisite | Status | Blocks / enables |
|----|--------------|--------|------------------|
| PRE-1 | **Workspace abstraction (A2)** — per-agent isolation / clean tree | `[ ]` | N2 (clean snapshot), N25, N26, N27, G1, G8, F4 |
| PRE-2 | **Session-wide budget / iteration cap** — per-agent budgets were removed in v0.24.0, so there is **no backstop**; every auto-loop must carry its own cap until this lands | `[ ]` | N1, N5, N11, N12, N13, N32 |
| PRE-3 | **Event-sourcing full (A1)** — run progress event-sourced (today the loop drives off in-memory `spawned[]`) | `[ ]` | N28-durable, N27 |

---

## All competitive-sweep features (N1–N39)

Sorted by ID. See research §3 scorecard + §4/§5 for full detail and the verifier corrections (the load-bearing parts).

| ID | Feature | Theme | Tier | Effort | Status | Key note / caveat / dependency |
|----|---------|-------|------|--------|--------|--------------------------------|
| N1 | Deterministic done-gate (run-until-green + re-route) | Verification | strategic | L | `[ ]` | Most-validated idea in the field. Re-route = **fresh spawn**, not redirect (sessionId is CLI-bound). Needs own iteration cap (PRE-2). Per-project opt-in; degrade w/o a test cmd. Ship same-provider retry first. |
| N2 | Regression-aware verification (fail/pass-to-pass) | Verification | strategic | L | `[ ]` | Compute SWE-bench "resolved" verdict; replaces untrustworthy `tests_run` regex in `handoffPayload.ts`. Clean before-snapshot collides w/ shared workspace → partial dep on N35/PRE-1. Per-project opt-in + changed-tests fast mode. |
| N3 | Deterministic row-transition gates (shell, stderr feedback) | Verification | strategic | M | `[x]` v0.41.0 | **Shipped (once-after-plan variant):** per-project `gateCommand` (Director ⋯ menu) runs once after an auto-mode plan; exit 0 = pass, non-zero redirects the LAST agent with the output to fix (cap 2) then stops + surfaces. `agents/gate.ts` (spawn, real exit code, abort-aware), wired in acceptPlan. Plan suppression now auto-only in `runner.ts` so the gate can't fire outside auto. Opened the verification spine (N1/N2 next). |
| N4 | Living PLAN (re-scope remaining rows from evidence) | Planning | strategic | L | `[ ]` | `planDiff.ts` was built for this; gate point after `awaitCompletion`. Opt-in, material-change-only, user-gated, bounded; never re-add completed rows. Distinct from F2 (manual 2-plan diff). |
| N5 | Task + Progress Ledger + auto-replan on stall | Planning | strategic | L | `[x]` v0.42.0 (safe half) | **Shipped the safe half (ledger + stall pause; NOT auto-replan).** A live progress ledger rides on the accepted-plan DirectorMessage as `ledger?` (persisted + broadcast like critique/confidence — no new channel); the accept loop (`ipc/director.ts`) derives it after each `awaitCompletion` and patches it. Deterministic, conservative stall counter (`director/ledger.ts`, `STALL_LIMIT=2`): errored-no-change OR same-files-repeat-while-failing; read-only roles carved out. At 2 consecutive no-progress steps the run **pauses + surfaces** (stops spawning remaining rows + a ⚠ system message) — no auto-replan. `LedgerCard` renders in stream + chat views. **Deferred (gated on PRE-2):** the auto-replan loop. |
| N6 | Run-scoped blackboard (shared mutable artifact store) | Planning | strategic | L | `[x]` v0.42.0 | **Shipped as N5's storage layer (merged, not double-counted).** `blackboard.ts` + migration v33 `blackboard_entries` (run_id = the plan's message id), one entry per agent completion written at the `query.ts` handoff chokepoint (no-op outside an active run), size-capped to 50/run, cascade-deleted with the project. The ledger derives from it. **Deferred:** size-bounded injection of the blackboard digest into later agents' spawn context (sequentially the Director already sees handoffs in order; pair with N18 sizing). |
| N7 | **Plan Critic** (adversarial pre-spawn plan review) | Pre-spawn | strategic | M | `[x]` v0.36.0 ✅ | **SHIPPED v0.36.0.** One-shot haiku critic (`director/critic.ts` via `runClaudeQuery`) on plans ≥3 rows, claude-only, advisory; `orchestrator-critique` block parsed in `parse.ts`, persisted (migration v29), rendered as per-row `!`/`!!` badges + a ⚑ PLAN CRITIC footer on PlanCard. Tune levers if noisy: critic prompt + effort low→medium. |
| N8 | Pre-acceptance clarifying-questions round-trip | Pre-spawn | quick-win | S | `[x]` v0.37.0 | **SHIPPED v0.37.0.** Auto-mode-only: Director emits `orchestrator-questions` (≤3, parsed in parse.ts via extractDirectives) instead of a plan when ambiguous; QuestionsCard renders answer fields; submitting folds answers back via the normal `send` (resumes session) → grounded plan. Persisted (migration v30). PRD's `open_questions` kept separate (static, no fold-back). Tune the ask-vs-plan gate in prompt.ts if it over-asks. |
| N9 | Plan confidence score + driving ambiguities | Pre-spawn | quick-win | S | `[x]` v0.39.0 | **Shipped:** Director emits a sibling `orchestrator-confidence` block (score 0–100 + 1–3 ambiguities) alongside a plan → confidence pill + bar + △ DRIVING AMBIGUITIES footer on the PlanCard. Informs the existing confirm; never blocks. Prompt tie-in: low confidence → prefer N8 questions instead. Uncalibrated hint. |
| N10 | Plan-aware Verifier vs per-row acceptance criteria | Verification | strategic | L | `[ ]` | Optional `criteria` per PlanRow; read-only verify pass → `orchestrator-verdict`. Verifier: a fail does **not** halt the chain today (new conditional logic). Ship advisory first; pair w/ N1/N2/N3 floor. |
| N11 | Multi-lens review fan-out (+ cross-provider reviewer) | Review | strategic | M | `[ ]` | Quality/Impl/Simplification/Testing/Docs reviewers over one fixed diff + fixer loop. **Read-only over a fixed diff → sidesteps F4.** Not wall-clock parallel here (canvas dressing); hard round cap (PRE-2). |
| N12 | Adversarial verify-and-converge loop (bounded) | Review | strategic | M | `[ ]` | Ship generator→critic→revise core; **defer the refute-half** (wants parallelism) into N11. Needs a concrete rubric (convergence weak off Playwright happy path). Loop cap. |
| N13 | Inline confidence-scored "disprove" pass | Review | strategic | M | `[ ]` | Cheap read-only micro-agent (Haiku) returns 0–100. Feed the **actual git diff**, not the heuristic list. Soft signal on top of a deterministic floor; hard loop cap; label "cheap-model opinion." |
| N14 | Ground-truth telemetry via Claude Code's OTEL stream | Observability | strategic | L | `[ ]` ⚠️ | OTEL mechanism verified; but **re-introduces removed observability** — needs fresh why-now + a chosen consumer UI on the dormant DB cols. Short runs may exit before metric flush (lower interval + JSONL fallback); don't clobber user OTEL config. Enabler for A5. |
| N15 | Cross-CLI spend reconciliation from local JSONL | Observability | strategic | M | `[ ]` ⚠️ | Frame as the **out-of-app / offline / Codex** view, not an in-app accuracy fix. Prefer vendoring/shelling `ccusage` over a hand-rolled JSONL parser. |
| N16 | Trajectory health score for completed runs | Observability | strategic | M | `[ ]` | Heuristic-first (no key); green/amber/red chip in HandoffPayload. **Drop the out-of-scope-edits dimension** (no `declaredScope` field exists). Build the reference-free efficiency baseline. |
| N17 | Per-role statistical cost-anomaly guard | Observability | strategic | M | `[ ]` ⚠️ | The per-agent ceiling it builds "on top of" **was removed** — reframe. Needs min-sample floor. Real delta: "anomaly guarding on a CLI with no API key." |
| N18 | Segmented context breakdown + optimizer card | Observability | quick-win | S | `[x]` v0.38.0 | **Shipped reframed:** NOT the deleted always-on cost meter (cut as noise in v0.24.0). On-demand "Context" tab in the inspector → estimated tokens per *injected-at-spawn* source (role prompt / project skill / MEMORY.md / subtype / task); CLI-loaded skills + MCP surfaced as uncounted notes. chars/4 estimate, no tokenizer dep. |
| N19 | Per-row plan-approval gate (read-only → unlock writes) | Safety/scope | strategic | L | `[ ]` ✅ | **Clean recommend.** Claude Code Agent Teams ships this verbatim. The `'approval'` status is **dormant** (wire it end-to-end). New read-only→full two-phase spawn + directive + approval queue/UI. Verify `--resume` honours a changed tool set. Claude-only. **L is right.** |
| N20 | Three-tier tool allow-list ('ask' gate) | Safety/scope | strategic | M→L | `[ ]` | **No push channel exists** (keep approval in-app / OS toast). Surfacing 'ask' headlessly = a permission MCP server over bidi `stream-json` = spawn/runner rewrite (F4-class). Reclassify M→L; trim to approve/edit/reject. |
| N21 | Per-row file-path edit allow-list (fileRegex) | Safety/scope | strategic | M | `[ ]` ✅ | **Clean recommend.** Lead with a **PreToolUse hook returning `permissionDecision:"deny"` — it overrides `bypassPermissions`** (verified). Not enforced for MCP tools (match MCP tool names too). Claude-only. |
| N22 | Per-role egress firewall / network allow-list | Safety/scope | strategic | L | `[ ]` | `HTTP_PROXY` is **not** a security boundary (hostile child drops it). Real exfil defense = WFP/AppContainer (native Windows = the real L). Two phases. **See G3** (CLI ships a sandbox, but WSL2-only). |
| N23 | Project constitution (always-on house rules) | Knowledge | strategic | M | `[ ]` | Impact **medium** — advisory text into a CLI we don't control, **not enforced** (don't oversell). Draw a crisp line vs per-role skill vs MEMORY.md. Size-bound the injection. G4 makes it self-populating. |
| N24 | Actionable diff comments → scoped re-spawn | HITL | strategic | M | `[ ]` | Comment **persistence is net-new** (file+hunk+offset keys; `logNotes` won't do). Focused-fix is single-file → multi-file needs the spawn path extended. The diff renderer is the shared foundation for N25/N26 — sequence it first. |
| N25 | Best-of-N coder attempts + diff picker | Best-of-N | strategic | L | `[ ]` | N attempts **sequentially**, one throwaway branch each → sidesteps F4; validates A2 cheaply. Ephemeral-worktree clean-reset is the risky L part. N× cost, no backstop (PRE-2) → gate by a "race this row" toggle. Codex `--attempts` is cloud-only. |
| N26 | Tool-call checkpoints w/ three-way restore | Time-travel | strategic | L | `[ ]` | Realistic granularity = **per assistant-turn** (we observe post-hoc). Prefer shadow-git in userData (NTFS no reflink). **Differentiator: make restores reversible + never touch the user's `.git`** (competitors' restores corrupt repos). |
| N27 | Per-agent-step time-travel (rewind/edit/fork) | Time-travel | bold-bet | XL | `[ ]` ⚠️fit | **Leaky abstraction**: rewinding the conversation doesn't roll the disk back (agents mutate real files) → forked tail runs on a corrupted tree. Hard dep on **A2 (PRE-1)** + A1. MVP = git-commit-per-boundary so "replay" = git-reset. |
| N28 | Durable cross-session resumable runs + sign-off | Time-travel | strategic | L | `[ ]` | **Best architecture-fit of the set.** Split: the **sign-off gate is a quick win** (pause the loop before next spawn behind a toggle); durable rehydration needs run-progress event-sourced (**PRE-3 / A1**). |
| N29 | Plan-as-code via Dynamic Workflows | Orchestration | strategic | L | `[ ]` | Most directly-adjacent capability (shipped 2026-05-28 in the CLI we drive). **Path (a) only** (shell + observe; we can't host the script). Headless workflow event schema **undocumented** (canvas-render risk). Subagents **bypass our governance** — frame as "trade control for scale." |
| N30 | Editable Flightdeck (conditional edges, loop nodes) | Orchestration | bold-bet | XL | `[ ]` | Split: ship interactive add/reorder/edit of the **linear** plan on canvas first (real win); gate conditionals/loops/parallel groups behind the runtime work (F4 + a control-flow interpreter that doesn't exist). |
| N31 | Adversarial debate fan-out for root-cause | Orchestration | strategic | L | `[ ]` | **Read-only investigators → sidesteps F4 blocker.** But concurrency needs a new spawn path (drop the await-gate) **+ a join/barrier** (none exists) → real cost L/XL. Investigators debate *through* the Director (not Agent-Teams parity). |
| N32 | Verification watch-loop after ship gate | Autonomy | strategic | M | `[ ]` ⚠️ | Runaway spend — **hard low retry cap (e.g. 3) + cumulative-$ stop (PRE-2)** + failure-fingerprint dedup. Looped coder needs a *looser* prompt than focused-fix. gh-checks path = opt-in. |
| N33 | Scheduled / ambient runbook runs + notify | Autonomy | bold-bet | L | `[ ]` | Single-instance lock means headless **aborts while the GUI is open** → must be an **in-app main-process cron loop**. **No Electron `Notification`/`Tray` exists** (net-new). |
| N34 | Off-device push when blocked / done | Autonomy | quick-win | M | `[ ]` | OS toast (no relay) + optional user webhook (ntfy/Pushover/Slack, signal-only). First concrete emitter for backlog **A5**. The "blocked" half is coupled to N20; without it you ship only the commodity "done" toast. |
| N35 | Warm workspace recipe (per-project setup snapshot) | Autonomy | strategic | M | `[ ]` | **Not** an A2 slice (touches isolation zero). Honest value = a **deterministic test command** that N2/N25/N32 consume. Route recipe stdout/stderr through `secretScrubber`. |
| N36 | Architect/Editor two-model split in one row | Cost lever | strategic | M→L | `[ ]` ⚠️ | **Two-pass runner orchestration** (parse pass-1 → feed pass-2, swap allow-lists) = M→L, in `agents/internal.ts`. Claude-first. The spend-optimizer card it was pitched as **was removed** → needs measured before/after. |
| N37 | Auto-condense long context | Cost lever | skip | — | `[-]` ❌ | **Skip** — infeasible at our layer; the CLIs we drive already auto-compact (we don't own the message array). Narrow salvage: record the CLI's own compaction as an event; expose Codex's `model_auto_compact_token_limit` as per-project config. |
| N38 | Run-vs-run comparison diff | Observability | strategic | M | `[ ]` ⚠️ | Reads the `.orun` bundle; makes prompt-overrides + provider/effort choices empirically evaluable. Aligning rows across **non-identical** plans is the real work. N2/N16 axes are sibling proposals, not shipped. Extends **F2**. |
| N39 | Failed run → regression runbook | Observability | strategic | M | `[ ]` | Hard-dep **N2** (recurrence assertion) + **P11.1** (multi-row capture; only 1-row ships). Replay is **non-deterministic** → frame as "regression-watch runbook," not an eval suite. |

---

## Paradigm-level gaps (G1–G8) — what the sweep itself missed

From the completeness critic; arguably the most novel. Detail in research §6. All shippable within constraints unless noted.

| ID | Gap | Tier | Effort | Status | Key note |
|----|-----|------|--------|--------|----------|
| G1 | **Repo code-graph index** (grounds planning + review) | strategic | L | `[ ]` | **Highest-leverage addition.** Local symbol/import graph (ripgrep + tree-sitter, no key, offline) → ~2× bug-catch (Greptile 82% vs CodeRabbit 44%). Strengthens N7/N8/N10/N11/N12/N13 at once. Cleanest version leans on A2. |
| G2 | **Trifecta guard + MCP tool-description pinning** | strategic | M | `[ ]` | We run untrusted skills + MCP + repo/web content (lethal trifecta) with no injection story. Two slices reuse the shipped skill-source audit: (a) pin+diff MCP tool descriptions between runs; (b) per-plan "trifecta lint" warning. Shippable today; a genuine differentiator. |
| G3 | **Configure Claude Code's NATIVE sandbox per role** | strategic | M | `[ ]` | Don't rebuild N22/N26 — the CLI ships an OS-enforced sandbox (`allowedDomains`/`filesystem.allowWrite`). **WSL2-ONLY, no native Windows** → gate behind a detected WSL2 workspace or coarser fallback. Reshapes N22's framing. |
| G4 | **Learned-memory loop (reflexion)** | gap | M | `[ ]` | Post-run consolidation pass distils durable facts into a version-controllable learned-rules file that auto-injects next time + feeds N16 baselines. Makes **N23 / N38 / N39 self-populating** vs hand-authored. |
| G5 | **AGENTS.md as shared read/write contract** | gap | M | `[ ]` | Read AGENTS.md as a first-class Director grounding source + write our rules back → interop with the user's bare `claude`/`codex`/`cursor` sessions (cross-tool standard). Complements N15. |
| G6 | **Unified Agent Inbox** | gap | M | `[ ]` | One triage queue for every pending decision (plan-accept / tool-approve / verify-failed / run-finished). The home once gates (N19/N20) + ambient runs (N33) exist; what N34's push deep-links into. |
| G7 | **PR-native delivery (stacked diff per row)** | gap | M | `[ ]` | Graphite-style stack: one small dependent PR per plan row, each independently reviewable. Reuses the user's `gh`; completes the shipped auto-branch + backlogged auto-PR; feeds N32 real CI signal. |
| G8 | **Hand-off-to-background worker** | gap | M | `[ ]` | Spawn the headless engine **detached** against a throwaway worktree; keep the foreground Director interactive; surface in the Agent Inbox (G6) on completion. Bridge between the shipped headless engine and N33; validates the worktree abstraction (F4/N25). |

---

## QOL / miscellaneous

Smaller quality-of-life items (not from the sweep). Add freely.

| ID | Item | Status | Note |
|----|------|--------|------|
| QOL-2 | Close pill on agent nodes (abort-if-running + remove) | `[x]` v0.40.0 | No way to close/remove an agent existed — `removeAgent` IPC was dormant with no caller. Hover-reveal circular × off the node's top-right corner → `window.api.removeAgent` (aborts running first; confirm gate for active agents). Permanent delete (drops the DB row + notes), not a soft-hide. |
| QOL-1 | Scrollable full agent-log view in the inspector | `[x]` v0.37.1 | Post-5b regression: the Drawer Logs tab (`Drawer.tsx` `LogsTab`) renders only `agent.log.slice(-8)` — last 8 lines + a count badge that implies more; the old full-stream viewer (`AgentStreamPanel`) was deleted in the Flightdeck redesign. Add a scrollable full log (up to `LOG_TAIL_CAP`, `query.ts`). **This is the one surface where TanStack Virtual earns its keep** if the full log hits the cap — otherwise plain render is fine. |

### Recently shipped (for reference)
| Item | Version | Status |
|------|---------|--------|
| N5+N6 — Task/Progress ledger + run-scoped blackboard (safe half; stall pause, no auto-replan) | v0.42.0 | `[x]` |
| N3 — Deterministic verification gate after a plan (run-until-green ×2) | v0.41.0 | `[x]` |
| QOL-2 — Close pill on agent nodes (abort-if-running + remove) | v0.40.0 | `[x]` |
| N9 — Plan confidence pill + driving ambiguities on the PlanCard | v0.39.0 | `[x]` |
| N18 — Injected-context breakdown card (inspector "Context" tab) | v0.38.0 | `[x]` |
| Director node polish (wider node, header declutter, mode dropdown) | v0.37.2 | `[x]` |
| QOL-1 — Scrollable full agent-log view in the inspector | v0.37.1 | `[x]` |
| N8 — Pre-acceptance clarifying-questions round-trip | v0.37.0 | `[x]` |
| N7 — Plan Critic (advisory pre-spawn plan review) | v0.36.0 | `[x]` |
| Dark mode (light / dark / system) | v0.35.0 | `[x]` |
| Top bar re-theme + editable model picker | v0.34.1 | `[x]` |
| Elapsed-time fix across redirect | v0.34.2 | `[x]` |
| Opus 4.8 · 1M as built-in default model | v0.35.0 | `[x]` |
| Colour hygiene (stale terminal-green scrub) | v0.35.0 | `[x]` |
| Flightdeck redesign (1–5c): node-graph canvas | v0.25.0–v0.34.0 | `[x]` |

---

## Suggested sequencing (from research §7)

1. **Quick wins, no blockers:** N8 · N9 · N34 · N18.
2. **Verification spine:** N3 → N1 (same-provider retry first) → N2 → N11; ship **N7** alongside (cheap, clean-recommend).
3. **Grounding (biggest missed leverage):** **G1** — multiplies step 2 + N7/N8.
4. **Safety/scope:** N21 (PreToolUse deny) → N19 (plan-approval) → G2 (trifecta) + G3 (native sandbox, WSL2-gated).
5. **Closed-loop planning:** N4 → N5+N6 (merged) → N16.
6. **Autonomy arc:** N28 sign-off-gate half + N33 (in-app cron + Electron notifications) + G6 (Agent Inbox) + G8 (background worker).
7. **Bold bets, after the abstractions land:** N25/N31 (sequential fan-out value w/o F4) → N28-durable → N29 (path-a) → N30 (linear-first) → N27 (gated on A2).
8. **Don't build:** N37.

**Decide first:** PRE-1 (workspace abstraction / A2) and PRE-2 (session-wide budget/iteration cap) — they gate or backstop most of the above.

---

## How to update

- Move status `[ ]` → `[~]` → `[>]` → `[x]` (or `[-]`) as work progresses; link the branch at `[>]`, the version at `[x]`.
- Keep the **★ Priorities** table in sync with the master rows.
- When an item ships, also tick it in **Recently shipped** and update the relevant memory if it changed architecture.
- The research doc is the source of truth for *why* + caveats; keep this file the *status* layer (don't duplicate the detail).
