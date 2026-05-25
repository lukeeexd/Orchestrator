# Spike — Per-agent worktrees (P13 re-investigation)

**Status:** Doc-spike + resume-cwd experiment complete (2026-05-25).
Recommendation below has been updated.
**Date:** 2026-05-21 (original doc), 2026-05-25 (resume-cwd experiment).
**Owner:** N/A — pick this up when forks see real use.

## Resume-cwd experiment — 2026-05-25 outcome

The original doc flagged path (c) "fork-attached worktrees" as
blocked on an unverified assumption: that `claude --resume <id>`
tolerates a `cwd` change between session resumes. Ran the
experiment, claude CLI v2.1.150:

**Setup.** Two distinct workspaces (`dir-A` / `dir-B`) under a
temp directory, each holding a `marker.txt` with workspace-
distinguishing content.

**Turn 1.** From `dir-A`, ran `claude --print --output-format
stream-json` with the prompt "Read marker.txt and report the
content as MARKER=...". Result:

- `cwd` from the init event: `dir-A` ✓
- Read tool called with the **absolute path**
  `<dir-A>\marker.txt` — the CLI resolved the relative path to
  absolute before the tool call. (Interesting detail in itself:
  even within a single session, the relative-path → absolute-path
  resolution happens upfront.)
- Result: `MARKER=I am workspace A.` ✓
- Session id captured.

**Turn 2 (the spike).** From `dir-B`, ran the same `claude
--print --resume <session-id>`. Result:

```
No conversation found with session ID: dc88647c-ba74-4efe-...
```

The CLI doesn't even **find** the session from a different cwd —
sessions are stored under `~/.claude/projects/<encoded-cwd>/`
(the same path-encoding F16's memory bridge uses), and `--resume`
only looks in the current cwd's session pool.

**Control.** Re-running the resume from `dir-A` works fine: the
agent recalls "I am workspace A." So the session itself is healthy;
the failure is specifically the cwd-scoped lookup.

**Conclusion.** **`claude --resume` does NOT tolerate a cwd
change.** Any feature where an agent's session needs to be
resumed from a different working directory is structurally
blocked by the CLI's session-storage design.

## Implications for the three candidate paths

- **(a) All plan-spawned agents in worktrees** — still dead. The
  original M4 reason (sequential artefact flow needs a shared
  workspace) is unaffected, and the new finding adds a second
  death blow: redirect / fork wouldn't work because the agent's
  session was created in workspace X but the runner would later
  try to resume from worktree Y.
- **(b) Opt-in "isolated experiment" checkbox** — **newly dead**.
  Even if you opt-in to a worktree at spawn time, the redirect
  affordance from the Drawer would fail the moment it tried to
  resume the session from the worktree's cwd. (Spawn alone works;
  any subsequent interaction is broken.) Could be kept alive by
  restricting opt-in agents to "no redirect / no fork," but that
  cripples the affordance just when isolation matters most.
- **(c) Fork-attached worktrees** — **dead in current shape**.
  The fork's resume would happen from the worktree's cwd, which
  the CLI refuses. The whole point of fork-with-worktree is to
  isolate, so the resume can't fall back to the parent's cwd.

## What COULD work — different architecture

The constraint is "session lookup is cwd-scoped." That bounds
the design space:

1. **Always-same-cwd for an agent's lifetime.** Today's state.
   Locks in shared workspace per agent. No worktrees, no
   isolation.
2. **Per-agent FRESH workspace from spawn time, no resume across
   sessions.** Each agent gets its own worktree at spawn; runner
   never resumes from a different cwd. Forks would create a NEW
   conversation (lose session memory) rather than `--resume`.
   Some features (Drawer's Redirect button) would have to be
   redefined to mean "start a new conversation in the same
   workspace with the prior context summarised" rather than
   "continue the same session."
3. **CLI feature request.** Ask Anthropic to support `claude
   --resume <id> --workdir <path>` or expose the session pool
   path. Out of our hands.
4. **Different provider where session storage is cwd-independent.**
   The Codex CLI's session model is already different (no
   `--resume` flag at all); a future provider abstraction could
   make session-portability a first-class concern.

The cleanest path now is **A2 (workspace as interface)** from
`docs/product/feature-proposals.md`. Once `Workspace` is an
interface, the runner can compose "spawn in worktree, retain
session memory by sticking to that worktree" without leaking the
cwd constraint into every feature that touches an agent. Today's
"workspace = path string" assumption makes it impossible to
*locally* fix this because every spawn / redirect / fork has its
own implicit cwd handling.

## Updated recommendation

1. **F4 paths (a) / (b) / (c) all dead in their current shape.**
   Don't ship any of them against today's runner.
2. **A2 is now a genuine prerequisite for F4 / F14.** The
   workspace abstraction has to express "this agent's worktree
   path AND its CLI session pool path" so the runner can
   reconstitute both on every redirect / fork.
3. **F5 (rewind Director) is NOT blocked by this finding.** The
   Director's cwd is `app.getPath('userData')` and stable across
   the app's lifetime; rewinding doesn't change cwd. F5's
   separate risk (resume-after-truncation semantics) is still
   open but unrelated.
4. **Provider plug-ins (F13) become more interesting.** A
   provider with session-portability would unblock per-agent
   worktrees naturally; Anthropic's CLI doesn't, but a future
   one might.

---

The original 2026-05-21 doc continues below for context.

## Background — what M2 had, what M4 dropped

The original M2 plan (May 2026) gave every spawned agent its own git
worktree under `.orchestrator-worktrees/<agent-name>` on a fresh
branch. Justification at the time: parallel execution isolation.
Implementation lived in `src/main/agents/worktree.ts`.

The code shipped, lasted ~5 days, then `d3ed6ad` ("drop per-agent
worktrees; give researcher Write+Edit") tore it out. The reasoning,
verbatim from that commit body:

> The researcher role had Read/Glob/Grep/WebFetch only — no Write or
> Edit. Anything it learned lived in its assistant text, which
> evaporates at handoff. Downstream agents (pm, coder) had no artefact
> to read.
>
> Each agent was being spawned into its own
> `.orchestrator-worktrees/<name>` branch. Even if researcher COULD
> write, the file lived in research-01's isolated worktree — pm-01
> never saw it. Worktrees made sense in M2 when agents ran in parallel;
> now that auto-spawn is sequential (post-M4), the isolation actively
> breaks the chain of artefacts the Director relies on.

The fix was two-pronged: give the researcher write access AND make
every agent run in the same workspace, so a `research-notes.md` from
agent N is on disk for agent N+1.

`Agent.worktreePath`, the Drawer's Worktree field, and the
`worktree.ts` module all disappeared in that commit.

## What's changed since the drop, and what hasn't

| Concern | M4 state | Today |
|---|---|---|
| Plan execution | Sequential — Director plans rows that flow data forward | **Unchanged.** Auto-mode still spawns rows one at a time. |
| Researcher artefacts | Researcher writes markdown to cwd | **Unchanged.** Now baked into the role prompt. |
| Concurrent agents | Not supported | **Not supported.** Plan rows are still strictly sequential. |
| Fork | Not yet wired | **Shipped (v0.3).** Drawer Fork button uses `claude --resume <id> --fork-session`. The forked agent inherits the parent's session memory but runs in the same workspace. |
| Marketplace skills | Not yet | **Shipped (v0.8).** `git-worktree-manager` skill exists in `alirezarezvani/claude-skills` with patterns the orchestrator could lift — see "Patterns to lift" below. |

The structural premise that killed worktrees in M4 — sequential
artefact flow inside a single workspace — is still load-bearing. We
cannot put plan-spawned agents back into their own worktrees without
re-introducing the same downstream-blind problem.

## Three candidate places to put worktrees back

### (a) All plan-spawned agents

**Verdict: no-go.** Same problem as M4. The researcher writes
`api-mapping.md`; the coder needs to read it; if the coder's worktree
is on a different branch, the file isn't there. Could be unblocked by
forcing every agent to commit + push to a shared integration branch
between rows, but that's a coordination layer the Director doesn't
have and the user probably doesn't want.

### (b) Opt-in "isolated experiment" checkbox at spawn time

**Verdict: viable, modest payoff.** A checkbox in SpawnAgentForm
("Run in isolated worktree (rollback-friendly)") spawns the agent on
a fresh branch under `.orchestrator-worktrees/<agent-name>`. Solves
the "agent went off the rails, I need git rollback" gap that
`d3ed6ad`'s commit body explicitly accepted as a trade-off
("use git stash / git reset on the workspace if an agent goes off
the rails").

Costs:
- New checkbox + branch-name input in spawn form
- DB column to remember the worktree path per agent
- Worktree creation in the runner (only when checkbox set)
- Drawer field showing the worktree path + a "discard branch" button
- Cleanup policy on agent abort / remove

Adds UX surface and an edge case in the runner. Most users probably
won't use it on most spawns — the value is in the rare case where
you want to throw an experimental agent at a risky change without
contaminating your working tree.

### (c) Fork-attached worktrees

**Verdict: best fit semantically.** Forking is already the
"branch off and try something else" operation. Today the fork shares
the parent's workspace — so if you fork to try an alternative
implementation, the parent's working tree gets touched too. A
fork-attached worktree on a `fork/<parent-name>/<timestamp>` branch
would make fork mean what users probably already assume it means.

Costs:
- Forks already track `forkedFromId` / `forkedFromName` — schema-wise
  this is the smallest change.
- One git command at fork time, one cleanup hook at terminal status.
- No new UX surface — fork already has its own Drawer button.

Risk: the forked agent's `claude --resume <id>` resumes a session
whose conversation memory references files at paths in the parent's
workspace. A different worktree path means those paths no longer
resolve. Need to verify by experiment whether the SDK / agent copes
with a cwd change between resume sessions.

## Patterns to lift from `alirezarezvani/git-worktree-manager`

The skill (already in our default marketplace) documents patterns
worth borrowing for whichever path ships:

- **Deterministic branch naming.** Skill uses `wt-<feature>`; we'd
  use `fork/<parent>/<ts>` or `experiment/<agent>`. Predictable names
  make cleanup safe.
- **Stale detection.** Skill scans worktrees by age before pruning.
  Map to: agents in terminal status for >N days get their worktree
  flagged for cleanup.
- **Dirty-state detection.** Never auto-remove a worktree with
  uncommitted changes; require explicit user confirmation. Skill's
  `worktree_cleanup.py` has the safety checks worth porting.
- **Merged-branch detection.** If the fork's branch has been merged
  back upstream, the worktree is safe to remove.

The skill also covers port allocation and `.env` copying — both
**not relevant** to Orchestrator. Our agents don't run dev servers;
they edit files and run tests. Ignore those sections.

## Recommendation

Don't ship anything for P13 right now. The strategic case is weakest
where the effort would be largest (path **a**), and best where the
effort is smallest (path **c**) — but path **c** has an unverified
risk around `claude --resume` cwd changes that needs an actual
experiment, not a doc spike.

Concrete next step when this becomes a real priority:

1. **Verify the resume-cwd assumption.** Spike a single fork with a
   manually-created worktree on a side branch. Confirm
   `claude --resume <id>` with a different `cwd` doesn't blow up the
   session's memory of file paths from the parent's workspace. This
   is a single-afternoon experiment.

2. **Ship path (c) — fork-attached worktree** if (1) passes. Single
   feature slice. Schema migration adds `worktree_path TEXT` to
   `agents`. Fork's runner branch creates the worktree on fork; the
   agent's `cwd` is the worktree path; the Drawer shows the path +
   a "Merge fork into parent" / "Discard fork" pair.

3. **Optionally ship path (b)** as a separate slice once (c) lands
   and we've seen how the worktree-cleanup UX feels. Same plumbing,
   just exposed at spawn time as a checkbox.

Out of scope decisions, captured for the next session that re-opens
this:

- Path (a) is dead until parallel agents exist. Don't argue for it
  on rollback grounds — `git stash` covers that already.
- Director never gets a worktree. Director's `cwd` is
  `app.getPath('userData')` and it doesn't touch the workspace.
- No port allocation. No `.env` copying. Not our use case.
- No automatic merge of fork worktrees. The user merges or discards
  manually — auto-merge would be a Git crime.

## References

- `d3ed6ad` — the original drop commit. Read the body for the
  artefact-flow argument verbatim.
- `PLAN.md` line 31 — the "Per-agent isolation" decision row.
- `alirezarezvani/claude-skills` → `engineering/skills/git-worktree-manager` —
  patterns for cleanup, naming, and stale detection.
