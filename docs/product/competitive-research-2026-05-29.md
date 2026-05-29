# Competitive deep-dive — feature ideas for Orchestrator (2026-05-29)

> Research-only artifact. No code was changed. This is a survey of tools similar to
> Orchestrator and a filtered, adversarially-verified list of features worth adding.
> Produced by a multi-agent research sweep (53 sub-agents, ~3.25M tokens, ~26 min of
> live web research): 6 landscape scouts → 6 per-category feature miners → 1 synthesis
> pass → 39 per-feature skeptic verifiers + 1 completeness critic. Every "competitor does
> X" claim and every "fits our architecture" claim below was independently web- and
> code-checked by a verifier whose job was to *disprove* it.

---

## 0. Read this first — a correction to our own baseline

The sweep was primed with a "what Orchestrator already ships" inventory drawn from
`PLAN.md` / `docs/product/feature-proposals.md`. **A verifier caught that this inventory
is stale.** Commit `92a85b1` (**v0.24.0**, _"feat(spend): remove token/cost tracking,
budgets, and the Spend screen"_) deliberately deleted:

- the **Spend screen** + its whole engine (`spend.ts`, `spendForecast.ts`,
  `spendRecommendations.ts`, the spend optimizer, the cost-forecast chip on PlanCard);
- **all cost/token display** (top-bar pills, Drawer KPI tiles, per-model table,
  AgentRow token/cost columns);
- the **per-agent context-window meter** (the `/context`-style gauge);
- **budgets/caps entirely** — `checkBudget`, the wall-clock timer enforcement, and budget
  UI. The commit body states plainly: _"Agents now run to completion or until manually
  stopped."_

DB columns were left dormant. The stated rationale: _"the user doesn't track per-agent
spend and the pills/screens were noise."_

**Why this matters for the list below:** several features were pitched as "sharpen an
existing chip" or "the budget hard-stop is the safety backstop." Those framings are
wrong now. Any feature touching cost / budgets / context-% is really a *re-introduction*
of a surface the owner cut on purpose — so it needs a fresh single-user justification, not
"make the existing numbers better." Affected: **N1, N2, N5, N7, N9, N11, N12, N14, N15,
N16, N17, N18, N32, N36, N38**. Each is flagged inline. (The two biggest consequences:
there is **no budget backstop** anymore, so every auto-looping feature must carry its own
explicit iteration cap; and **N14/OTEL** becomes "rebuild observability you removed," not
"tighten existing numbers.")

---

## 1. Where Orchestrator sits in the 2026 landscape

The field has converged hard on **one shape**: a kanban/worktree model where
*card = git worktree = agent*, with parallelism isolated by git worktrees
(Conductor, Vibe Kanban, Crystal/Nimbalyst, Claude Squad, cmux, Cursor, Windsurf, Zed)
or by Docker/cloud VMs (Sculptor, Devin, Jules, Codex cloud, Augment). **Parallelism is
table stakes everywhere else.** The universal value-add wrapped around it is
**verification**: competitors no longer trust an agent's self-report. Bernstein's
merge "janitor" gate, Dex's 5-lens parallel review + fixer loop, Jules' Planning Critic
and CI-fix loop, Augment's Verifier-against-acceptance-criteria, and Claude Code's own
code-review plugin (0–100 "disprove" scores) all independently reinvented *compute the
verdict, don't believe the agent*. Plan-before-code is now standard (Cursor / Cline /
Windsurf Plan modes; Kiro / Spec Kit spec chains; Devin confidence-gated planning), as is
per-step time-travel (LangGraph checkpoints, Cline shadow-repo restores) and
native-OTEL / local-JSONL cost telemetry.

**Orchestrator's distinctive position** — a Director-led, role-specialised, **sequential**
pipeline driven entirely by the user's installed CLI; single-user, local-first, no
backend, no SDK, Windows-first, rendered on a node-graph **Flightdeck** rather than a
kanban — is *increasingly validated, not dated*. Claude Code's own docs caution that naive
5-agent plan/code/test/review pipelines underperform a single sequential agent because
subagents lose the context the next one needs; and Roo Code (which pioneered the
role-agent + delegation pattern) shut down (repo archived 2026-05-15). What Orchestrator
already does that few peers match: a Director that plans *and re-plans*, structured
agent→Director handoffs, a skill marketplace with a security audit, project-scoped secrets,
`.orun` portable run bundles, a **headless scriptable engine**, and **Event-sourcing
Lite** — it is structurally the durable local checkpointer that LangGraph needs Postgres
for.

**Where it's behind:** (1) **verification** — it builds rich handoff payloads but *trusts*
them (`tests_run` is regex-scraped and could be a lie); (2) it has **no parallelism, no
best-of-N, no run-until-green** convergence — the headline competitor capabilities;
(3) the **Flightdeck is read-only** where every visual peer lets users shape the graph;
(4) it lacks **unattended/scheduled runs and off-device notification**, which sting more
in a sequential model where one mid-chain approval stalls everything; and — per the
completeness critic — (5) it treats the **repo as something agents grep at runtime**, with
no semantic code-graph grounding, and (6) it has **no security story for the agents it
itself spawns** (untrusted skills + MCP servers + repo content = a textbook lethal
trifecta).

> **The throughline of the best ideas:** keep the validated sequential spine and bolt on
> the field's *verification* and *grounding* layers — exploiting that Orchestrator drives
> the same `claude` CLI whose native hooks, plan-approval, sandbox, and Dynamic Workflows
> are directly adjacent. Turn "spawns agents and reports what happened" into "**gets you to
> verified working code.**"

---

## 2. Top recommendations (the curated shortlist)

If you only act on a handful, these are the highest value-per-effort, best-fit, genuinely
new ideas. Full detail and caveats for each are in §4 / §5.

### Quick wins (ship-now, S–M effort, no blockers)
| ID | Feature | Why it's a quick win |
|----|---------|----------------------|
| **N8** | Pre-acceptance clarifying-questions round-trip | New `orchestrator-questions` fenced block + a Q&A card cloned from PRDCard. Lives entirely in the Director turn, no spawn-loop change. Cursor/Cline/Windsurf all do this. Guards the most expensive failure: a wrong plan. |
| **N9** | Director plan confidence + ambiguities | A confidence pill + the 1–3 driving ambiguities on the PlanCard. Devin reports green-confidence ≈ 2× merge rate. *Note: plan is a bare `PlanRow[]` — needs a small wrapper or sibling block.* |
| **N34** | Off-device push when blocked / done | OS toast (zero relay) + optional user-pointed webhook (ntfy/Pushover/Slack). The "walk away from a long sequential run" story. First concrete emitter for backlog **A5**. |
| **N18** | Segmented context breakdown card | *Resurrects* the context meter (deleted with the Flightdeck redesign) **and** attributes tokens per injected component (role prompt / overrides / MEMORY.md / skills / MCP). Mirrors Claude Code `/context`. |

### Highest-leverage strategic bets (the "get to working code" spine)
| ID | Feature | Why it matters |
|----|---------|----------------|
| **N1** | Deterministic done-gate (run-until-green + re-route) | The biggest category shift: host runs lint/typecheck/tests after a row, re-spawns on failure, re-routes model after N tries. *Single most-validated idea in the landscape* (Bernstein, Jules, Genie). |
| **N3** | Deterministic row-transition gates | A code-enforced correctness floor: user shell gate on row completion; non-zero exit blocks handoff and feeds stderr back. Maps onto Claude Code hooks. The deterministic layer under N1/N2. |
| **N7** | **Plan Critic** — adversarial pre-spawn plan review | A cheap second model critiques the *plan* (missing roles, bad ordering, mis-scoped tasks, wrong allow-lists) *before any spend*. Jules' Planning Critic cut task-failure 9.5%. **One of two clean "recommend" verdicts.** |
| **N2** | Regression-aware verification (fail-to-pass + pass-to-pass) | Compute the SWE-bench "resolved" verdict instead of trusting `tests_run`. Replaces the untrustworthy regex scrape with a real before/after delta. |
| **N19** | Per-row plan-approval gate (read-only → unlock writes) | Move the checkpoint to *before* the work: agent runs read-only, emits a plan, Director/human approves, then write tools unlock on the same session. Claude Code Agent Teams ships this verbatim. |
| **N11** | Multi-lens review fan-out | Replace the 2-row ship gate with Quality / Implementation / Simplification / Testing / Docs reviewers over one fixed diff + a fixer loop. **Read-only over a fixed diff, so it sidesteps the F4 parallelism blocker.** |
| **N4** | Living PLAN (re-scope remaining rows from evidence) | Each handoff becomes a re-plan checkpoint; the Director revises only not-yet-run rows from agent evidence, user-gated. `planDiff.ts` already exists for the diff. |
| **N16** | Trajectory health score | Score the *path* an agent took (duplicate calls, Bash-retry storms, tool-failure spikes) into a green/amber/red chip the Director sees. Pure post-processing of already-classified logs; no key for the heuristic tier. |

### Paradigm-level gaps the sweep itself missed (from the completeness critic — arguably the most novel)
| ID | Idea | Why it's the biggest miss |
|----|------|---------------------------|
| **G1** | **Repo code-graph index** that grounds planning *and* review | Every review feature reviews the *diff only*; every planning feature reasons from chat. Both are blind to the "invisible 20%" (cross-file breaks, sibling callers, auth hooks). A local symbol/import graph (ripgrep + tree-sitter, no key) roughly *doubles* bug-catch rate (Greptile 82% vs CodeRabbit 44%). Strengthens N7/N8/N10/N11/N12/N13 at once. |
| **G2** | **Trifecta guard + MCP tool-description pinning** | Orchestrator runs user-subscribed skills + MCP servers + untrusted repo/web content as child processes — the textbook lethal trifecta — but has no prompt-injection / MCP-poisoning story. Reuses the shipped skill-source audit machinery. |
| **G3** | **Configure Claude Code's NATIVE sandbox per role** (don't rebuild it) | The CLI Orchestrator drives now ships an OS-enforced sandbox (`allowedDomains` / `filesystem.allowWrite`). Map per-role tool allow-lists onto it instead of reinventing N22. **Crucial constraint the sweep missed: it's WSL2-only, NO native Windows** — a first-order finding for a Windows-first app. |

### Bold bets (high-leverage, but XL or blocked)
- **N28** Durable, cross-session resumable runs with mid-run sign-off gates — Orchestrator
  is *structurally* the durable local checkpointer (SQLite + Event-sourcing Lite + `.orun`)
  that competitors need a backend for. Best architecture-fit of any proposal. (Split it:
  the sign-off gate is a quick win; durable rehydration is the L part and leans on full A1.)
- **N29** Plan-as-code via Claude Code **Dynamic Workflows** — the single most directly-
  adjacent capability in the field (it shipped 2026-05-28 in the exact CLI we drive).
  Path (a) only: Director shells the `workflow` keyword and we observe. *Caveat: the
  `/workflows` progress view is interactive-only; the headless stream-json workflow event
  schema is undocumented — verify before promising canvas rendering.*
- **N25** Best-of-N coder attempts with a side-by-side diff picker — runs N attempts
  *sequentially* against throwaway branches, so it ships best-of-N value **without** the
  blocked F4 fan-out, and validates the A2 workspace abstraction with the cheapest case.

### Skip
- **N37** Auto-condense long context — **architecturally infeasible at our layer and already
  done by the CLIs we drive.** We hand the CLI a prompt + session id; it owns the message
  array via `--resume`. We can't drop spans or splice summaries. Both `claude` and `codex`
  already auto-compact. *Narrow salvage:* detect/record the CLI's own compaction as an event
  and expose Codex's `model_auto_compact_token_limit` as per-project config — observe, don't
  reimplement.

---

## 3. Scorecard — all 39 synthesized features

Tiers from the verifiers: **31 strategic, 4 quick-win, 3 bold-bet, 1 skip.** Verdicts:
3 clean `recommend` (N7, N19, N21), 35 `recommend-with-caveats`, 1 `poor-fit` (N37).
Novelty/impact/effort are the synthesis estimates; the verifier often sharpened effort
upward (noted inline in §4/§5).

| ID | Feature | Theme | Novelty | Impact | Effort | Tier |
|----|---------|-------|---------|--------|--------|------|
| N1 | Deterministic done-gate (run-until-green + re-route) | Verification | new | high | L | strategic |
| N2 | Regression-aware verification (fail/pass-to-pass) | Verification | extends | high | L | strategic |
| N3 | Deterministic row-transition gates (shell, stderr feedback) | Verification | new | high | M | strategic |
| N4 | Living PLAN (re-scope from handoff evidence) | Planning | extends | high | L | strategic |
| N5 | Task + Progress Ledger with auto-replan on stall | Planning | new | high | L | strategic |
| N6 | Run-scoped blackboard (shared mutable artifact store) | Planning | new | medium | L | strategic |
| N7 | **Plan Critic** (adversarial pre-spawn plan review) | Pre-spawn | new | high | M | **strategic ✅recommend** |
| N8 | Pre-acceptance clarifying-questions round-trip | Pre-spawn | new | high | M→S | **quick-win** |
| N9 | Plan confidence score + clarify-gate | Pre-spawn | new | high | S | **quick-win** |
| N10 | Plan-aware Verifier vs per-row acceptance criteria | Verification | extends | high | L | strategic |
| N11 | Multi-lens review fan-out (+ cross-provider reviewer) | Review | extends | high | M | strategic |
| N12 | Adversarial verify-and-converge loop (bounded) | Review | extends | high | M | strategic |
| N13 | Inline confidence-scored "disprove" pass | Review | new | medium | M | strategic |
| N14 | Ground-truth telemetry via Claude Code's OTEL stream | Observability | extends | high | L | strategic ⚠️ |
| N15 | Cross-CLI spend reconciliation from local JSONL | Observability | extends | medium | M | strategic ⚠️ |
| N16 | Trajectory health score for completed runs | Observability | new | high | M | strategic |
| N17 | Per-role statistical cost-anomaly guard | Observability | extends | medium | M | strategic ⚠️ |
| N18 | Segmented context breakdown + optimizer card | Observability | new | medium | S | **quick-win** ⚠️ |
| N19 | Per-row plan-approval gate (read-only → unlock) | Safety/scope | new | high | L | **strategic ✅recommend** |
| N20 | Three-tier tool allow-list ('ask' gate) | Safety/scope | new | high | M→L | strategic |
| N21 | Per-row file-path edit allow-list (fileRegex) | Safety/scope | extends | medium | M | **strategic ✅recommend** |
| N22 | Per-role egress firewall / network allow-list | Safety/scope | new | medium | L | strategic |
| N23 | Project constitution (always-on house rules) | Knowledge | extends | medium | M | strategic |
| N24 | Actionable diff comments → scoped re-spawn | HITL | extends | high | M | strategic |
| N25 | Best-of-N coder attempts + diff picker | Best-of-N | backlogged | high | L | strategic |
| N26 | Tool-call checkpoints w/ three-way restore | Time-travel | new | medium | L | strategic |
| N27 | Per-agent-step time-travel (rewind/edit/fork) | Time-travel | extends | high | XL | **bold-bet** ⚠️fit |
| N28 | Durable cross-session resumable runs + sign-off | Time-travel | extends | high | L | strategic |
| N29 | Plan-as-code (Dynamic Workflows) | Orchestration | extends | high | L | strategic |
| N30 | Editable Flightdeck (conditional edges, loop nodes) | Orchestration | extends | medium | XL | **bold-bet** |
| N31 | Adversarial debate fan-out for root-cause | Orchestration | backlogged | high | L | strategic |
| N32 | Verification watch-loop after ship gate | Autonomy | extends | high | M | strategic ⚠️ |
| N33 | Scheduled / ambient runbook runs + notify | Autonomy | new | medium | L | **bold-bet** |
| N34 | Off-device push when blocked / done | Autonomy | new | medium | M | **quick-win** |
| N35 | Warm workspace recipe (per-project setup snapshot) | Autonomy | backlogged | medium | M | strategic |
| N36 | Architect/Editor two-model split in one row | Cost lever | new | medium | M→L | strategic ⚠️ |
| N37 | Auto-condense long context | Cost lever | — | — | — | **SKIP** ❌ |
| N38 | Run-vs-run comparison diff | Observability | extends | medium | M | strategic ⚠️ |
| N39 | Failed run → regression runbook | Observability | extends | medium | M | strategic |

⚠️ = framing depends on the cost/budget/context surface removed in v0.24.0 (see §0).

---

## 4. Detail — the features worth doing soonest

Each entry: what it is · how competitors do it · how it maps onto our code · the verifier's
correction/caveat (these are the load-bearing parts — the verifier's job was to find what
the synthesis got wrong).

### N1 — Deterministic done-gate: run-until-green with auto-retry + model re-route · `strategic`
Before a row is marked complete, the host runs an objective project gate (lint, typecheck,
the project test command). On failure it re-spawns the same row with the gate output
prepended; after N tries it re-routes to a different model/provider. **Refs:** Bernstein's
merge "janitor" (gates on tests/lint/types, routes failures to a different model — verbatim
match), Jules' CI-fix loop, Cosine Genie's run-until-tests-pass.
- **Fit:** intercept at `agents/query.ts consumeQuery`, the `result.subtype==='success'`
  branch (~L264) where the host currently marks the row done; per-project command store
  mirrors the validated per-project workspace pattern; re-spawn reuses `redirect.ts`.
- **Verifier corrections:** (1) **re-route ≠ redirect.** `redirect.ts` (L142–148) explicitly
  forbids changing provider/model-CLI on resume — the sessionId is tied to one CLI. A
  cross-provider re-route must be a *fresh spawn* with error context prepended, not a
  redirect. Same-provider/different-model retry can stay on the resume path. (2) **There is
  no budget backstop anymore** (v0.24.0); a green-chasing loop needs its *own* explicit
  max-iteration cap. (3) Value collapses on projects without a fast deterministic test
  command — make it strictly per-project opt-in, degrade gracefully. Ship same-provider
  retry first; cross-provider re-route as phase 2.

### N3 — Deterministic row-transition gates (shell checks block handoff) · `strategic`
User attaches a shell/script gate to row completion; non-zero exit blocks the handoff and
feeds stderr back into the agent's session to fix. The deterministic floor beneath N1/N2.
**Refs:** Claude Code hooks (`TaskCompleted` / `Stop` / `SubagentStop`, exit-2 blocks +
delivers stderr — confirmed), Kiro agent hooks.
- **Fit:** `director.notifyAgentDone` (reached only from the success branch in `query.ts`)
  is the gate point; failure reuses `redirectAgent` (which already resumes a done agent's
  session with a new instruction). We already shell out, so PowerShell/cmd gates are native.
- **Caveats:** gate commands run arbitrary shell — reuse the existing `notifySystem` trust
  pattern, require first-run confirmation, scope to the workspace. Add a max-retry cap.
  Handle the edge where a gate fires before any `result` event (no sessionId to resume).

### N7 — Plan Critic: adversarial pre-spawn review of the PLAN · `strategic` · ✅ clean recommend
A cheap second model critiques the *plan itself* — upstream of any spend — for missing
roles (a risky change with no qa/security row), wrong ordering, mis-scoped tasks, and
tool allow-lists that won't let a role do its job. Findings render as inline PlanCard
annotations. **Ref:** Google Jules' Planning Critic (a second agent reviewing every plan
before code executes; **9.5%** task-failure reduction — verified in Jules' changelog).
- **Fit:** "zero new architecture" holds — confirmed reuse surfaces: per-role allow-lists in
  `roles.ts`, the `extractDirectives` fenced-JSON parser (add `orchestrator-critique`),
  PlanCard's existing per-row inline badges, and the director/agent provider split (run the
  critic on the cheapest model). One extra `child_process` call between acceptance and first
  spawn.
- **Verifier note:** the "no competitor does this cleanly" line is overstated — Jules does
  exactly this for a single agent. The defensible delta is applying it to a **multi-agent
  fleet plan upstream of sequential spend** (the most expensive failure mode is spawning a
  5-row fleet off a bad plan). Gate by plan size so it doesn't tax trivial 1–2-row plans;
  ship inline annotations first, make auto-revise opt-in (avoid oscillation).

### N8 — Pre-acceptance research + clarifying-questions round-trip · `quick-win`
Before emitting a plan, the Director can emit a fenced `orchestrator-questions` block
(`[{question, why}]`); the renderer shows a Q&A card; answers fold into the next turn,
which emits a grounded plan. **Refs:** Cursor 2.1 Plan Mode ("responds with clarifying
questions… interactive UI to answer"), Cline Plan & Act, Windsurf Cascade Plan mode — a
convergent 2025 industry pattern.
- **Fit:** near-mechanical clone of `parsePrd` + a card cloned from `PRDCard.tsx`;
  `DirectorStream` already renders structured cards inline. No spawn-loop changes.
- **Caveats:** **reconcile with PRD mode** (which already emits an `open_questions` array but
  never folds it back) so you don't end up with two question-eliciting surfaces. "Codebase-
  grounded" is overstated — grounding comes only from MEMORY.md/WORKSPACE.md injection, not
  file reading (that's N4). Give the Director a clear gate for *when* to ask vs plan, or it
  adds friction to trivial tasks. Leans S, not M.

### N9 — Director plan confidence score + clarify-gate · `quick-win`
The Director emits low/med/high confidence + the 1–3 ambiguities driving it, shown as a
pill on the PlanCard. **Ref:** Devin 2.x Interactive Planning (🟢🟡🔴; green ≈ 2× merge
likelihood; merge rate ~doubled 34%→67%).
- **Load-bearing verifier correction:** the pitch ("turns auto mode from fire-and-forget into
  ask-first by gating the first spawn") **describes a problem that's already solved** —
  `App.tsx:565-571` already makes plans wait for an explicit human confirm; auto-mode only
  auto-fires *redirects* to running agents, not the initial fleet spawn. Reframe the value
  as: (a) a confidence pill + ambiguities informing the *existing* confirm; (b) when
  confidence is below a user-set bar, prompt the Director to emit clarifying questions
  *before* it bothers emitting a plan. Schema nuance: the plan is a bare `PlanRow[]`, so this
  needs a small wrapper object or a sibling fenced block. Present confidence as a hint
  (self-reported, uncalibrated), not a guarantee.

### N2 — Regression-aware verification (fail-to-pass + pass-to-pass) · `strategic`
Snapshot test outcomes before a change, re-run after, compute a SWE-bench-style verdict:
target tests must now pass AND no previously-passing test went red. **Ref:** SWE-bench
Verified harness; research (_"Are 'Solved Issues' Really Solved?"_, arXiv 2503.15223,
ICSE 2026) documents ~6.2pp resolution inflation from weak validation — directly justifies
distrusting `tests_run`.
- **Fit:** two `child_process` runs of the project test command + an outcome diff — the
  pattern already used in ~17 main-process files. Replaces the best-effort regex scrape in
  `handoffPayload.ts`.
- **Caveats:** effort L may be understated (running an arbitrary suite *twice* is fragile:
  flaky/slow tests, DB/server deps, monorepos). The clean "before" snapshot collides with
  the shared-workspace problem (the coder mutates the same tree) — **partially gated on N35**
  (deterministic workspace) and brushes the A2 abstraction. Ship behind per-project opt-in
  with a changed-tests fast mode. Downgrade the LangSmith citation to a footnote; keep
  SWE-bench primary.

### N19 — Per-row plan-approval gate (read-only plan mode → unlock writes) · `strategic` · ✅ clean recommend
Spawn the agent with read-only tools + a prompt to emit an `orchestrator-agent-plan` (files
it intends to touch, approach, tests); Director auto-approves against promptable criteria
("only approve plans with test coverage", "reject plans that touch the DB schema") or a
human approves on the node; on approve, write tools unlock on the *same* `--resume` session.
**Ref:** Claude Code Agent Teams ships "Require plan approval for teammates" near-verbatim,
including those exact criteria strings; Cline Plan & Act confirmed.
- **Verifier corrections (both inflate ease):** (1) the `'approval'` status exists in the
  `AgentStatus` union + `STATUS_TINT` but **nothing ever sets it** — it's a dormant
  enum+colour, not live machinery. (2) `parse.ts` only handles plan/redirect/prd; the new
  directive + the auto-approval queue are net-new. Real scope: new read-only→full two-phase
  spawn path, new directive+validator, a new approval queue/UI, wiring the dormant status
  end-to-end — **L is right, don't downgrade.** Verify the CLI honours a changed tool set on
  `--resume` before committing. Gate to the `claude` provider (codex lacks the tool control).

### N11 — Multi-lens parallel review fan-out · `strategic`
Replace the 2-row ship gate with Quality / Implementation / Simplification / Testing / Docs
reviewers over the *same fixed diff*, aggregated by a fixer that loops to clean; optionally
a cross-provider reviewer (review Opus's code with Codex). **Ref:** Dex runs exactly these
5 named reviewers + a fixer loop (up to 3 rounds; ships Windows binaries); Bernstein adds
the cross-model review.
- **Why it's clever:** read-only over a fixed diff → no working-tree contention, no
  worktrees, no cwd-scoped `--resume` → **sidesteps the F4 parallelism blocker entirely.**
  Reuses `READONLY_TOOLS`, the `SHIP_GATE_ROWS` append path, the per-agent provider override,
  and `redirect.ts`.
- **Caveats:** it is **not** parallel in wall-clock here (agents are sequential) — the
  "fan-out" is canvas dressing (N nodes → fixer node); honest, but it's ~5–7 extra runs +
  up to 3 fixer rounds. There's **no budget backstop** anymore, so enforce a hard round cap.
  Keep the lens set toggleable.

### N4 — Living PLAN: Director re-scopes remaining rows at each handoff · `strategic`
On a material scope change in a handoff, the Director emits a fresh plan covering *only*
not-yet-run rows (re-scope a downstream task, drop a redundant row, insert a fix/verify row);
a gate pauses before the next spawn for accept/edit, and `planDiff.ts` renders the delta.
Distinct from backlog **F2** (manual diff of two plans): here the plan mutates from agent
*evidence*. **Ref:** the general re-plan-from-evidence + human-checkpoint pattern (Magentic,
ReCAP, Cocoa); Cline Focus Chain as the lighter analogue.
- **Fit (unusually clean):** the sequential-spawn loop is a tight for-loop in `ipc/director.ts`
  (~250–294) with a natural gate point after `awaitCompletion(prev.id)`; the re-plan is just
  another `orchestrator-plan` block `parse.ts` already parses; `planDiff.ts` was *literally*
  built for this.
- **Caveats:** the team deliberately suppressed handoff verbosity to save budget — make
  re-plan opt-in, material-change-only, user-gated, and bounded (cap re-plans/run; never
  re-add completed rows). Codex tends to skip fenced blocks → degrade gracefully. Soften the
  Augment "Intent" citation (its living-spec story is multi-agent; our differentiator is
  "each sequential handoff is a parallel-merge-free re-plan checkpoint").

### N16 — Trajectory health score for completed runs · `strategic`
Score the *path* an agent took — tool-selection appropriateness, duplicate calls,
Bash-retry storms, tool-failure spikes, path efficiency — into a green/amber/red chip the
Director sees and that rides inside the HandoffPayload, so a "succeeded but thrashed" run is
visibly flagged. Heuristic-first (no key); optional LLM-judge tier. **Refs:** LangChain
`agentevals` (local trajectory matchers, no key), LangSmith, AgentOps loop/drift detection.
- **Verifier correction:** `architectureFit` claims "focused-fix already records a declared
  scope to diff edits against" — **false.** Focused-fix enforces scope only in the *prompt
  string*; there's no structured `declaredScope` field anywhere. So the "out-of-scope edits"
  signal can't cheaply diff against a recorded scope — **drop or defer that one dimension**
  and ship the robust signals (duplicate calls, retry storms, tool-failure rate, path
  efficiency vs a per-role call-count envelope). The reference-free efficiency score is
  *more* novel than the cites imply (agentevals needs a reference trajectory) — the baseline
  must be built.

---

## 5. Detail — the rest, grouped by theme

### Verification & correctness (the dominant landscape theme)
- **N10 — Plan-aware Verifier vs per-row acceptance criteria** (`strategic`). Optional
  `criteria` field per PlanRow; a read-only verify pass checks the handoff against *those*
  criteria and emits `orchestrator-verdict`. Augment's Verifier / Copilot self-review / Amp's
  Oracle. **Verifier correction:** "a fail halts the chain like a row error" is *false* — the
  loop proceeds regardless of done vs error; only a spawn *exception* halts. New conditional
  logic needed → justifies L. Ship advisory (non-gating) first; make gating opt-in once the
  judge proves reliable. Pair with a deterministic floor (N1/N2/N3).
- **N12 — Adversarial verify-and-converge loop** (`strategic`). Critic scores vs rubric →
  coder revises → bounded convergence check. **Ref (primary source):** Anthropic's Dynamic
  Workflows blog — "other agents try to refute what they found… iterating until answers
  converge… results checked before folded in." **Caveats:** convergence signal is weak off
  the Playwright happy path (`parseTestsKpi` only fires there) — needs a concrete rubric; the
  refute-half wants parallelism we don't have (sequential works but costs more). Ship the
  generator→critic→revise core; defer the refute variant and fold it into N11.
- **N13 — Inline confidence-scored "disprove" pass** (`strategic`). A cheap read-only
  micro-agent (e.g. Haiku) tries to disprove the diff, returns 0–100; below threshold bounces
  back, the score is a per-agent trust chip. **Ref:** Claude Code code-review plugin (0–100,
  default threshold 80, drops sub-threshold). **Caveats:** feed it the *actual git diff* of
  files_touched, not the heuristic list; ship as a soft signal *on top of* a deterministic
  floor; hard loop-cap; label the chip "cheap-model opinion."

### Closed-loop planning & supervision
- **N5 — Task + Progress Ledger with auto-replan on stall** (`strategic`). Two living
  artifacts + a deterministic stall counter that fires regardless of whether the LLM notices.
  **Ref:** Magentic-One ships this verbatim ("stall count > 2 → revise ledger + replan").
  **Caveats:** split it — the ledger/UI is safe strategic work; the **auto-replan loop is the
  risky half** (replan→spawn→stall→replan oscillation). The stated guardrail is insufficient:
  per-agent caps cap *one* agent, not a Director minting *new* agents each replan — needs an
  explicit max-replans counter **and** the unshipped session-wide budget cap as a hard dep.
- **N6 — Run-scoped blackboard** (`strategic`). Shared mutable per-run artifact store every
  agent reads/writes; the data model that makes auto-replan and future fan-out coherent.
  **Refs:** MetaGPT, CrewAI Flows shared state, AutoGen ContextVariables. **Caveats:** heavy
  overlap with N5 — **merge them or frame N6 as N5's storage layer** (don't double-count two
  L bets). Full payoff is gated on F4 parallelism; sequentially the Director already sees
  every handoff in order. Size-bounded injection (N18 pairing) is mandatory.

### Safety, scope & approval gating
- **N20 — Three-tier tool allow-list ('ask' gate)** (`strategic`). A middle tier between
  allow/deny: gated capabilities (push, delete, Bash, network) pause for approve/edit/reject.
  **Refs:** n8n HITL tools, LangGraph `interrupt()`, CrewAI `@human_feedback`. **Two false
  claims the verifier caught:** (1) "PushNotification/RemoteTrigger channel already
  available" — **there is no such channel in `src/`**; a phone-push surface needs a relay,
  which violates local-first → keep approval in-app (OS toast at most). (2) "just surface the
  CLI's own out-of-allowlist prompt" — we run `--permission-mode bypassPermissions` one-shot;
  surfacing 'ask' headlessly is the *hard* path (the only working route is a permission MCP
  server over bidirectional `--input-format stream-json`, i.e. a spawn/runner rewrite — the
  same control-loop class of work that blocks F4). Reclassify M→L; trim to approve/edit/reject.
- **N21 — Per-row file-path edit allow-list (fileRegex)** (`strategic` · ✅ clean recommend).
  Each role/row declares a glob of paths it may edit; out-of-scope writes refused. **Ref:**
  Roo/Kilo custom-mode `fileRegex` (throws `FileRestrictionError`). **Key finding:** lead with
  a **PreToolUse hook returning `permissionDecision:"deny"` — it overrides `bypassPermissions`
  and fires anyway** (verified). Drop the "intercept Edit/Write in `query.ts`" fallback
  (`consumeQuery` only *observes*, can't refuse). Caveats: PreToolUse deny is **not** enforced
  for MCP tool calls (must match MCP tool names too); claude-only.
- **N22 — Per-role egress firewall** (`strategic`). Default-deny outbound + allow-list per
  role. **Ref:** Copilot's agent firewall (default-deny on Bash + registry allowlist;
  explicitly does **not** cover MCP — a gap we could close). **Load-bearing caveat:** an
  env-var `HTTP_PROXY` is **not** a security boundary against the malicious-skill threat (a
  hostile child drops the proxy / opens raw sockets). Real exfil defense needs WFP/AppContainer
  (native Windows work = the real L). Ship in two clearly-labelled phases. **See G3** — the CLI
  already ships a sandbox (but WSL2-only).
- **N23 — Project constitution** (`strategic`). One project-wide non-negotiables doc auto-
  injected into the Director *and* every agent (the Director-at-plan-time injection is the
  novel piece). **Refs:** Spec Kit `/constitution`, Kiro steering files, Tessl. **Caveats:**
  impact is *medium* not high — it's advisory text into a CLI we don't control, **not enforced**
  (don't oversell). Draw a crisp line between constitution (house law) / per-role skill /
  MEMORY.md (learned facts) or users won't know where rules go. Size-bound the injection.

### Human-in-the-loop, best-of-N, time-travel
- **N24 — Actionable diff comments → scoped re-spawn** (`strategic`). Render `git diff`, pin
  sticky-notes on diff lines, package into a focused-fix spawn. **Refs:** Vibe Kanban,
  Conductor. **Caveats:** "comment UI exists" is true but **"comment persistence exists" is
  not** — `logNotes` keys derive from log-line content; diff lines need a new file+hunk+offset
  key scheme. Focused-fix is single-file/whole-file-attach; multi-file diff comments need the
  spawn path *extended*, not just called. The diff renderer is the shared foundation for
  N25/N26 — sequence it first.
- **N25 — Best-of-N coder attempts + diff picker** (`strategic`, validates F4). N attempts run
  **sequentially**, one throwaway branch each, tree reset between — sidesteps the `--resume`
  cwd blocker. Human picks; auto-score is a hint only. **Refs:** Cursor 3.0 `/best-of-n`
  (parallel, auto-winner advisory), cmux crown evaluator. **Caveats:** ephemeral worktree
  lifecycle with guaranteed clean reset is the risky L part (orphaned worktrees are a known
  Codex pain); N× cost with no budget backstop → gate by a "race this row" toggle; N× wall-
  clock. Corrections: Codex `--attempts` is **cloud-only**; `local codex exec` has neither
  attempts nor worktrees.
- **N26 — Tool-call checkpoints w/ three-way restore** (`strategic`). Snapshot the workspace
  after each step → Restore Files / Restore Task / Restore Both. **Ref:** Cline shadow-git
  (exact three modes); Zed per-message restore. **Corrections:** realistic granularity is
  *per assistant-turn*, not per tool-call (we observe the CLI post-hoc — state honestly).
  sql.js export-on-save + NTFS-has-no-reflink → prefer shadow-git-in-userData, debounce/cap.
  **Differentiator:** both competitors' restores are bug magnets (Cline corrupts repos via
  `.git`→`.git_disabled`; Zed restore is irreversibly destructive) — win by making restores
  themselves reversible and never touching the user's `.git`.
- **N27 — Per-agent-step time-travel** (`bold-bet`, **fit=false**). Checkpoint at every agent
  boundary; scrub, edit, fork; replay upstream from cache. **Verified the substrate** (rewind,
  `fork.ts`, events, runBundle) — but the headline "replay upstream from cache" is a **leaky
  abstraction**: LangGraph can skip executed nodes because node outputs are pure in-memory
  state; *our agents mutate real files on a shared FS*, so rewinding the conversation doesn't
  roll the disk back — the forked tail runs against a corrupted workspace. The real, hard,
  unstated dependency is **A2 (workspace as interface)** — the same thing that blocks F4.
  Honest MVP: git-commit-per-agent-boundary so "replay" = git-reset to the checkpoint commit;
  or read-heavy tails only, behind a loud warning. Sequence after A1-full **and** A2.
- **N28 — Durable cross-session resumable runs + sign-off gates** (`strategic`, best fit of
  the set). A run becomes an event-sourced aggregate: checkpoint per agent boundary; on
  relaunch, rehydrate + offer Resume; completed agents short-circuit to cached handoffs;
  mid-stage sign-off reuses `PendingRedirectBanner`. **Verifier framing fix:** the "structurally
  out-does the flagship CLI" pitch is right vs Claude Code Dynamic Workflows (no cross-session
  resume) but **CrewAI Flows already ship `@persist` + `@human_feedback` locally** — so the
  edge is "desktop-native durable checkpointing in a director-led GUI," not "nobody else can."
  **Split it:** the sign-off gate is a quick win (pause the loop before the next spawn behind a
  per-plan toggle); durable rehydration is the L part and needs the run-progress state itself
  event-sourced (today the loop drives off in-memory `spawned[]`) — a real A1 dependency.

### Orchestration model evolution
- **N29 — Plan-as-code via Dynamic Workflows** (`strategic`). The Director emits a `workflow`-
  keyword prompt; the CLI's own runtime fans to up-to-1000 subagents, holding state out of
  chat context. **The most directly-adjacent capability in the field** (shipped 2026-05-28 in
  the exact CLI we drive). **Three caveats that require rewriting the pitch:** (1) **drop path
  (b)** — we cannot host Claude's script; the runtime runs isolated inside the CLI with no FS/
  shell. Only path (a) (shell + observe) is real. (2) `/workflows` progress is interactive-
  only; the headless stream-json workflow event schema is **undocumented** → the canvas-render
  is a delivery risk, verify first. (3) Workflow subagents **bypass Orchestrator's governance**
  (always `acceptEdits`, no per-role allow-lists, no handoff payloads, no approval gates) —
  a real tension with Orchestrator's identity; frame it as "delegate a sub-task to an opaque
  high-throughput run, trading control for scale."
- **N30 — Editable Flightdeck** (`bold-bet`). Promote the canvas from read-only render to an
  interactive editor (add/reorder nodes, conditional/router edges, loop nodes, parallel
  groups), Director validates the hand-edited graph. **Refs:** Flowise Agentflow 2.0 (also
  React-Flow-based), Google ADK Sequential/Parallel/Loop, CrewAI `@router`, Dify. **The caveat
  is the whole story:** the UI shell fits (React Flow is already in-tree) but the headline value
  collides with the engine — **parallel groups aren't executable (F4 blocked)** and
  conditional/loop nodes need a control-flow interpreter that doesn't exist. **Split:** ship
  interactive add/reorder/edit of the *linear* plan on canvas first (real quick→strategic win);
  gate conditionals/loops/parallel behind the runtime work.
- **N31 — Adversarial debate fan-out for root-cause** (`strategic`, validates F4). Several
  **read-only** investigators each pursue + try to disprove a hypothesis; the Director
  synthesizes. **Read-mostly → sidesteps F4's blocker** (fresh read-only investigators never
  `--resume` across a cwd change). **Ref:** Claude Code Agent Teams' flagship "5-teammate
  scientific debate" (recommend 3–5; cost scales linearly). **Correction:** "a parallel-read
  variant of the spawn loop" understates it — the loop is hard-sequential (`await
  awaitCompletion`); concurrency needs a new spawn path that drops the await-gate **plus a
  join/barrier** (no "all converged" trigger exists). Real cost L/XL. Investigators debate
  *through* the Director, not peer-to-peer (don't sell as Agent-Teams parity).

### Autonomy & unattended runs
- **N32 — Verification watch-loop after the ship gate** (`strategic`). After the chain + auto-
  branch, watch the test/build signal (or poll `gh` checks), auto-spawn a focused-fix coder on
  failure, loop until green or a cap. **Refs:** Jules CI-fix loop, Replit self-test loop, Genie.
  **Caveats:** **runaway spend** — no session-wide cap exists; the retry-cap must be hard + low
  (e.g. 3) plus a wired cumulative-$ stop. Need failure-fingerprint dedup (stop if the same
  failure recurs). The looped coder needs a *looser* prompt than focused-fix (which forbids
  running tests). gh-checks path = opt-in (auth/network).
- **N33 — Scheduled / ambient runbook runs + notify** (`bold-bet`). Fire a saved runbook on a
  schedule, notify on completion, surface as a pending PlanCard. **Ref:** Devin scheduled
  sessions (cron + email/Slack notify + past-sessions). **Two understated gaps:** (1) **process-
  model conflict** — the single-instance lock means a headless run *aborts* while the GUI is
  open (sql.js corruption guard); so the primary design must be an **in-app main-process cron
  loop**, not "fire the headless engine." (2) **notification plumbing does not exist** —
  `secondaryUpdater` only does an in-renderer `webContents.send`; there's **no Electron
  `Notification`/`Tray`** anywhere → OS toast when minimised is net-new. Differentiated though
  (Cursor/Copilot don't natively schedule).
- **N34 — Off-device push when blocked / done** (`quick-win`). OS toast (no relay) + optional
  user-pointed webhook (ntfy/Pushover/Slack — signal-only, never code). First concrete emitter
  for backlog **A5**. **Refs:** Happy Coder, Terragon. **Caveats:** the *differentiating* half
  (push the moment an agent blocks) is coupled to **N20** (not shipped) — without it you ship
  only the commodity "task done" toast. Don't build a hosted relay (local-first). Impact medium,
  honest.
- **N35 — Warm workspace recipe** (`strategic`). Per-project setup/test command recipe run via
  `child_process` with secrets-vault env injected. **Refs:** Devin/Jules/Codex environment
  snapshots. **Corrections:** the "slice of A2" framing is a stretch — it touches isolation
  zero; re-label as its own item (don't borrow A2's novelty discount). Cold-start savings are
  weak locally (node_modules persists); the **honest value is a deterministic test command that
  N2/N25/N32 consume.** New security surface: recipe stdout/stderr can leak secrets — route
  through `secretScrubber`. Spec what invalidates the cached-state marker.

### Cost levers
- **N36 — Architect/Editor two-model split in one coder row** (`strategic`). Pass 1 (strong
  model, read-only) plans; pass 2 (cheap model, edit/write) applies — two cooperating models in
  one row. **Ref:** Aider architect/editor (30–50% cheaper). **Caveats:** "mirrors the Playwright
  flavour" is misleading — that's one pass with extra prompt text; this is a **two-pass runner
  orchestration** (parse pass-1 output → feed pass-2, swap allow-lists per pass) = M→L, not M.
  Subtype branch lives in `agents/internal.ts`, not `roles.ts`. claude-first (codex can't pick a
  model on the ChatGPT plan). ⚠️ pitched as a spend-optimizer card — but the spend optimizer was
  removed in v0.24.0; needs a measured before/after, not a forecast.

### Observability (all ⚠️ — the surface these feed was removed in v0.24.0; see §0)
- **N14 — Ground-truth telemetry via Claude Code's OTEL stream** (`strategic`). A loopback OTLP/
  HTTP receiver in main + `CLAUDE_CODE_ENABLE_TELEMETRY=1` env injection per spawn → the CLI
  emits ground-truth cost/tokens/tool-decisions, tagged per agent via `OTEL_RESOURCE_ATTRIBUTES`.
  Content opt-ins stay off; loopback-only; no SDK/key. **Concrete enabler for backlog A5.**
  **The OTEL mechanism is real and verified** — but `claim=false` because the *integration plan*
  is built on the stale baseline: there's no heuristic scrape left to replace and no chips/meter/
  budgets left to feed (all removed in v0.24.0). **Reframe as reintroducing observability the
  owner cut as noise** — needs a fresh "why now" + a deliberate choice of which consumer UI to
  rebuild on the dormant DB columns. Two real risks: short role-runs may exit before metric
  export flushes (lower the interval **and** keep a JSONL fallback for claude too, not just
  codex); don't clobber a user's pre-existing OTEL config.
- **N15 — Cross-CLI spend reconciliation from local JSONL** (`strategic`). Read
  `~/.claude/projects/*.jsonl` (+ Codex) to report **out-of-app** CLI spend. **Ref:** ccusage
  (reads ~15 CLIs, offline, cache-token splits). **Caveats:** pitch it as the out-of-app/offline/
  Codex view, not an in-app accuracy fix (overlaps the removed surface + N14). Prefer
  vendoring/shelling ccusage over hand-rolling a drifting JSONL parser.
- **N17 — Per-role statistical cost-anomaly guard** (`strategic`). Soft pause-and-confirm when an
  agent burns anomalously vs that role's history — before the ceiling. **Caveats:** the
  per-agent budget ceiling it builds "on top of" **was removed** — reframe accordingly. Needs a
  min-sample floor (cold start). The robust signal is run-level $/role + tool-failure/retry
  spikes (verify retry-rate is extractable first). The real delta vs Helicone/AgentOps/Govyn:
  "proxy-grade anomaly guarding on a CLI with no API key," not "more accurate."
- **N38 — Run-vs-run comparison diff** (`strategic`). Diff two completed runs of the same
  plan/runbook on cost/tokens/wall-clock/files/tests/trajectory + a handoff-summary text diff,
  reading the `.orun` bundle. Makes per-role prompt overrides + provider/effort choices
  *empirically evaluable*. **Refs:** Braintrust / Phoenix / Weave side-by-side. **Caveats:**
  N2/N16 axes are *sibling proposals*, not shipped — scope without assuming them. Aligning rows
  across *non-identical* plans is the real design work. Extends backlog **F2** (plans → outcomes).
- **N39 — Failed run → regression runbook** (`strategic`). One-click capture a bad run as a
  parameterized regression case on a runbook; re-running reports whether the failure recurs.
  **Refs:** Braintrust "trace → eval", LangSmith "add problematic trace to dataset". **Caveats:**
  hard-depends on **N2** (the recurrence assertion) and **P11.1** (multi-row plan capture — only
  1-row capture ships today); replay is **non-deterministic** (we shell a non-deterministic CLI
  against live code) — reframe as "regression-watch runbook," not "eval suite."

---

## 6. Paradigm-level gaps (completeness critic) — what the whole sweep missed

The sweep is near-saturated on verification, closed-loop planning, time-travel, and
observability. The real gaps are **whole paradigms it never entered.** These are fully
shippable within Orchestrator's constraints unless noted.

- **G1 — Repo code-graph index (catch the "invisible 20%").** *Highest-leverage addition.*
  Every review feature reviews the diff only; every planning feature reasons from chat — both
  are blind to cross-file dependency breaks, sibling callers, auth/audit hooks, convention
  drift. A lightweight local symbol/import graph (ripgrep + tree-sitter, cached per project,
  no key, offline) lets (a) reviewers check the *callers* of a changed symbol and (b) the
  Director see the task's dependency neighbourhood *before* it plans. Greptile's full-repo graph
  ~doubles bug-catch (82% vs CodeRabbit 44%). Strengthens N7, N8, N10, N11, N12, N13 at once.
  *Leans on the worktree/workspace abstraction (A2) for the cleanest version.*
- **G2 — Trifecta guard + MCP tool-description pinning.** Orchestrator runs untrusted skills +
  MCP servers + repo/web content — the lethal trifecta — with no injection story (32% rise in
  indirect-injection content Nov'25–Feb'26; 8,000+ exposed MCP servers). Two slices reusing the
  shipped skill-source audit: (a) **pin + diff MCP tool descriptions** between runs (tool-
  poisoning hides instructions there); (b) a per-plan **"trifecta lint"** warning when one agent
  has web/MCP read + secrets-vault env + write/push at once, offering to break the triad. Fully
  shippable today; a genuine differentiator for a tool that runs third-party code.
- **G3 — Configure Claude Code's NATIVE sandbox per role (don't rebuild it).** N22 reinvents an
  egress firewall and N26 a shadow-repo time-machine — but the CLI now ships an OS-enforced
  sandbox (`@anthropic-ai/sandbox-runtime`: seatbelt/bubblewrap + network proxy,
  `sandbox.allowedDomains`, `filesystem.allowWrite`). Map per-role allow-lists onto its config
  and surface "this role runs sandboxed: writes cwd, reaches only npmjs.org" as a node badge.
  **First-order constraint the sweep missed: this sandbox is WSL2-only, NO native Windows** — for
  a Windows-first app, gate it behind a detected WSL2 workspace or fall back to a coarser policy.
  *This finding should reshape N22's framing.*
- **G4 — Learned-memory loop (reflexion, not read-only injection).** Memory is read-only today
  (MEMORY.md bridge) + an ephemeral blackboard. A post-run "consolidation" pass (cheap CLI call)
  distils durable facts — "sonnet beat opus on qa rows here", "this repo's tests need
  `--no-watchman`", recurring lint failures — into a version-controllable learned-rules file that
  auto-injects next time, and feeds measured outcomes back into N16 baselines (and any rebuilt
  forecast). The difference between Cursor Memories / Cline Memory Bank (evolving) and our static
  injection. Makes **N23 / N38 / N39 self-populating** instead of hand-authored.
- **G5 — AGENTS.md as the shared read/write contract with bare-CLI sessions.** Our constitution
  (N23), overrides, and learned memory live in app-private stores, so the user's bare
  `claude`/`codex`/`cursor` sessions see none of it. AGENTS.md is now the cross-tool standard
  (Codex, Cursor, Amp, Gemini CLI read it; Codex scopes review guidelines there). Read AGENTS.md
  as a first-class Director grounding source and write our rules back into it → interop, not
  lock-in. Complements N15 (share *config*, not just cost, with the bare CLI).
- **G6 — Unified Agent Inbox.** The sweep adds approval gates (N19/N20), scheduled runs (N33),
  and push (N34) *piecemeal* — but never the surface that ties them together: one triage queue of
  every pending decision (plan-needs-accept, tool-needs-approval, verify-failed, run-finished),
  each with the agent's reasoning, cleared with accept/edit/reject/respond. The LangGraph Agent
  Inbox / Codex-mobile-control pattern; the natural home once gates + ambient runs exist, and
  what N34's push deep-links into.
- **G7 — PR-native delivery (optionally a stacked diff per plan row).** We auto-branch but never
  produce a reviewable PR with the handoff summary as the body. The differentiated slice for a
  row-based tool is a **Graphite-style stack**: one small dependent PR per plan row
  (pm-spec → coder → qa), each independently reviewable. Reuses the user's `gh`; completes the
  shipped auto-branch + backlogged auto-PR; feeds N32 real CI signals.
- **G8 — Hand-off-to-background: offload a runbook to an unattended local worktree worker.**
  Every autonomy idea keeps compute on the foreground sequential machine; the 2026 default is
  offloading to a background/remote env and reviewing later. Local-first slice: spawn the headless
  engine as a *detached* worker against a throwaway worktree, keep the foreground Director
  interactive, surface in the Agent Inbox on completion. The bridge between the shipped headless
  engine and N33; validates the worktree abstraction F4/N25 depend on.

---

## 7. Suggested sequencing

A pragmatic order that front-loads value and respects dependencies:

1. **Quick wins, no blockers, this week:** N8 (clarifying questions), N9 (confidence pill —
   reframed per the verifier), N34 (OS-toast + webhook), N18 (context breakdown card).
2. **The verification spine (the "get to working code" story):** N3 (deterministic gate) →
   N1 (done-gate, same-provider retry first) → N2 (regression verdict) → N11 (multi-lens
   review). Ship N7 (Plan Critic) alongside — it's cheap, clean-recommend, and guards the most
   expensive failure.
3. **Grounding (the biggest missed leverage):** G1 (code-graph index) — it multiplies the value
   of everything in step 2 and of N7/N8.
4. **Safety/scope:** N21 (fileRegex via PreToolUse hook — clean recommend) → N19 (plan-approval
   gate) → G2 (trifecta guard) and G3 (native sandbox config, WSL2-gated).
5. **Closed-loop planning:** N4 (living plan) → N5+N6 *merged* (ledger with blackboard as its
   storage) → N16 (trajectory score).
6. **Autonomy:** N28's sign-off-gate half + N33 (in-app cron + real Electron notifications) +
   G6 (Agent Inbox) + G8 (background worker) form one coherent "walk away" arc.
7. **Bold bets, after the abstractions land:** N25/N31 (sequential best-of-N / read-only debate
   fan-out — both ship fan-out *value* without the blocked F4 write-fan-out), then N28-durable,
   N29 (Dynamic Workflows path-a), N30 (editable canvas, linear-first), N27 (gated on A2).
8. **Don't build:** N37.

**Two cross-cutting prerequisites** that keep recurring and are worth deciding deliberately:
the **workspace abstraction (A2)** — gates N2's clean snapshot, N25, N26, N27, F4, G1, G8 — and
a **session-wide budget/iteration cap** (per-agent budgets were *removed*, so every auto-looping
feature — N1, N5, N11, N12, N13, N32 — currently has *no* backstop and must carry its own cap).

---

## 8. Competitor landscape (reference)

The tools the scouts surfaced, by beat. Relevance = how directly comparable to Orchestrator.

**Claude Code / Codex companions (the most direct competitors):** Conductor (Mac, parallel
worktree agents, plan-handoff, kanban grouping, diff-comment sync) · Vibe Kanban (OSS, card =
worktree = agent across 10+ CLIs, inline diff-comment feedback loop, own MCP server) · Sculptor
(Docker-isolated agents, plain-English "instruction audits", Pairing Mode) · Crystal/Nimbalyst
(Electron worktree sessions; dep. Feb'26) · Claude Squad (tmux TUI) · Claudia/opcode (Tauri GUI:
**checkpoint timeline with fork-from-checkpoint**, custom agents, sandboxed exec, analytics) ·
Happy Coder (E2E-encrypted mobile remote control + voice + push) · ccusage (offline cross-CLI
cost from JSONL) · Claude Code Router (task-aware multi-provider routing incl. Ollama) · cmux
(notification rings, solution benchmarking) · Terragon · claude-flow/Ruflo · **Dex** (5-lens
parallel review + fixer loop) · **Bernstein** (deterministic gate-and-merge janitor) · **Octogent**
(per-agent CONTEXT.md container).

**Agentic IDEs:** Cursor (≤8 parallel agents, Composer, Plan Mode, `/best-of-n`, `/multitask`) ·
Augment (Coordinator/Specialist/**Verifier** team around a living spec) · Roo Code (pioneered
Orchestrator/Boomerang mode — **shut down**) · Kilo Code (Roo successor; auto-delegation) ·
Cline (Plan/Act, **checkpoints/shadow-repo**, Focus Chain) · Sourcegraph Amp (Oracle/Librarian
subagents) · Aider (**architect/editor** split) · Windsurf Cascade · Zed (parallel agent threads) ·
Continue.dev · Trae SOLO · GitHub Copilot custom agents · **Claude Code Agent Teams** (peer
messaging + shared task list + plan-approval).

**Autonomous SWE platforms:** Devin (fleet of Managed Devins, **scheduled sessions**, Playbooks,
confidence-gated **Interactive Planning**) · OpenHands (event-sourced, **Condenser**) · Factory.ai
Droids (**Specification Mode** gate, Droid Exec headless) · **Google Jules** (parallel, **Planning
Critic** −9.5% failures, **CI-fix loop**, Environment Snapshots) · GitHub Copilot coding agent ·
OpenAI Codex cloud (`--attempts`, per-task sandboxes) · Replit Agent (self-test loop) · Codegen ·
Cosine Genie (run-until-tests-pass) · Bolt/Lovable/v0.

**Orchestration frameworks & visual builders:** LangGraph + Studio (**time-travel**, checkpoints) ·
**Claude Code Dynamic Workflows** (Director-authored JS script → ≤1000 subagents) · CrewAI (Crews +
Flows, `@persist`, `@human_feedback`, `@router`) · **Magentic-One** (Task/Progress Ledger +
stall-replan) · OpenAI Agents SDK (handoffs, guardrails, tracing) · AutoGen/AG2 · Google ADK
(Sequential/Parallel/Loop primitives) · MetaGPT · Flowise Agentflow 2.0 (React-Flow editor) · Dify
(IF/ELSE, loop, Human Input nodes) · n8n (HITL channels).

**Observability / eval / cost:** Langfuse · LangSmith · AgentOps (loop/drift detection,
time-travel) · Laminar · Braintrust (side-by-side experiment diff, trace→eval) · Arize Phoenix
(OTEL-native, baseline-run comparison) · Helicone (threshold alerts) · W&B Weave · OpenLLMetry ·
ccusage · **Claude Code native OTEL** · SWE-bench Verified harness · LangChain agentevals
(trajectory matchers).

**Emerging native / adjacent paradigms:** Claude Code native (subagents, **hooks**, plan mode,
checkpoints, output styles, **/context**, skills, **sandbox** [WSL2-only]) · Codex native subagents
+ sandbox · Cline Memory Bank · Kiro (**spec chain** requirements→design→tasks, steering files) ·
GitHub Spec Kit (constitution) · Tessl (spec = capabilities + linked tests) · Letta/MemGPT,
Mem0/OpenMemory, Zep/Graphiti, Cognee, Anthropic "Dreaming" (**learned memory**) · e2b/Daytona
(sandbox infra) · Greptile / Sourcegraph SCIP (**code-graph review**) · AGENTS.md (cross-tool
config standard) · LangGraph Agent Inbox · Graphite (stacked diffs).

---

## 9. Methodology & provenance

- **Sweep:** `Workflow` orchestration — 6 landscape scouts (one per beat) → 6 per-beat feature
  miners → 1 synthesis pass (dedup + gap-analyse against our shipped + backlogged inventory) →
  39 per-feature skeptic verifiers (each web- and code-checking novelty / architecture-fit /
  competitor-claim accuracy) + 1 completeness critic. 53 sub-agents, ~3.25M tokens, 947 tool
  calls, ~26 min.
- **Confidence:** every "competitor does X" claim was checked against primary sources (vendor
  docs / changelogs); every "fits our code" claim was checked against `src/`. Where a verifier
  found the synthesis wrong, the correction is folded inline above (these are the most valuable
  parts — e.g. N1's redirect-can't-switch-provider, N20's missing push channel, N27's leaky
  abstraction, N37's skip, and the §0 v0.24.0 correction).
- **Known limitation:** the priming inventory predated v0.24.0's spend/budget/context removal
  (see §0). Treat all ⚠️-marked observability/cost items as *re-introductions* of a deliberately-
  removed surface, not enhancements of an existing one. A few citations were flagged as loose by
  verifiers (Augment "Intent" for N4, LangSmith for N2, Cosine Genie for N7, Factory "Ambient"
  for N33) and softened in the text.
- **Raw data** (full scout/miner/synthesis/verdict JSON) is in the workflow transcript at
  `…/subagents/workflows/wf_4b9b082f-457`.
