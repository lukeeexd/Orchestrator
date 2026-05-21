# Spike — Per-agent worktrees (P13 re-investigation)

**Status:** Doc-only spike. No code changes. Recommendation below.
**Date:** 2026-05-21
**Owner:** N/A — pick this up when forks see real use.

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
