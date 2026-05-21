# Orchestrator — Plan

> A self-hosted Windows desktop app that runs an LLM **Director** which chats with the user and spawns specialised **agents** (pm / researcher / coder / qa / devops / security) to write code. Drives the user's installed `claude` (and optionally `codex`) CLI — no SDK bundled.

## How to use this doc

This is the **architecture + locked-decisions** reference. It's the stable layer that doesn't churn between releases.

For everything else:

- **What shipped in each release** → [GitHub Releases](https://github.com/lukeeexd/Orchestrator/releases). Each tag's curated body is the source of truth for what landed.
- **Open work** → [`BACKLOG.md`](./BACKLOG.md). The living tracker of ideas, scoped slices, and explicit deferrals.
- **Process boundaries inside the app** → [`LAYERS.md`](./LAYERS.md). Which directory can import from which.
- **UI handoff** → [`docs/design/README.md`](./docs/design/README.md).

A new Claude Code session should read this file first for orientation, then `BACKLOG.md` to see what's queued.

Decisions move from "Open questions" → "Decisions locked" once confirmed by the user. Do not silently revisit a locked decision.

## Status

**Current release:** see [GitHub Releases](https://github.com/lukeeexd/Orchestrator/releases) for the latest tag + curated notes.

The release cadence is roughly one minor every couple of days; each release is a self-contained bundle.

## Decisions locked

| Decision | Choice | Notes |
|---|---|---|
| Orchestration model | Director-led | An LLM Director plans and delegates; not manual routing |
| Frontend shell | Electron Forge + Vite + React + TypeScript | TS-first because the original runtime (Claude Agent SDK) was TS |
| Agent runtime | **Shell out to the user's installed `claude` (or `codex`) CLI** via `child_process.spawn`, structured-event stream over stdout | v0.2.0 dropped the bundled `@anthropic-ai/claude-agent-sdk` (218 MB `claude.exe` made the installer huge and asar-hostile — see commit `a0676b8`). We drive the user's own CLI install and stay out of the binary-distribution business. |
| Providers | `claude` (default) and `codex` (`codex exec --json`) | Each project picks one at creation; per-agent override via `provider` field. Director can run on a different provider than its agents via `directorProvider`. Codex Fork is disabled (no `--json` mode for `codex fork`); ChatGPT-plan codex users skip the `-m` flag. |
| Storage | `sql.js` (WASM SQLite, main process only) | Spike to swap for `better-sqlite3` was completed 2026-05-21 and deferred — Electron 42 reports module ABI 146 and the latest better-sqlite3 prebuilds top out at 145. Resurrect when prebuilds catch up. See BACKLOG S4 entry. |
| Per-agent isolation | None — sequential agents share the workspace | Original M2 plan used git worktrees; dropped after M4 once we made spawning sequential. Worktrees prevented downstream agents from reading what upstream agents had written. Re-spiked 2026-05-21 ([`docs/spike-2026-05-21-per-agent-worktrees.md`](./docs/spike-2026-05-21-per-agent-worktrees.md)) — fork-attached worktrees identified as the best candidate path, blocked on a `claude --resume` cwd-tolerance experiment. |
| Repo target | User points the app at a folder; agents work there | Manual merge back |
| API keys | Plain JSON in user data dir | OS keychain still pending — not yet a priority for a single-user app |
| Branch model | `dev` → `main` | Releases tagged on `main`; tags `vX.Y.Z` trigger `.github/workflows/release.yml` which builds the installer and creates the GitHub Release. Curated notes live in the annotated tag body. |
| Packaging | Electron Forge `MakerSquirrel` (`.exe` installer) | Windows-only. Switch to `MakerWix` if `.msi` becomes a requirement. |
| Auto-update | **`update-electron-app` against a self-hosted Squirrel feed on Cloudflare R2** (v0.15.0 onwards) | The R2 bucket hosts `RELEASES` + `*.nupkg` + `Orchestrator-Setup.exe`; CI uploads on every tag. Older clients (v0.14.x) still poll `update.electronjs.org`; once they update to v0.15.0+ they cut over to R2. R2 hosting unlocks repo-private. A secondary signalling channel polls a Pages `latest.json` as belt-and-suspenders. |
| ASAR integrity fuses | `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` **deliberately off** | Re-enabling them in v0.4.0 broke installs silently (process launched, integrity check failed, no error dialog). Don't re-enable without verifying the integrity-hash flow end-to-end through Squirrel. |
| Code signing | Deferred (H7 in 2026-05-18 review) | The installer is unsigned; SmartScreen warns on first run. More prominent now that the public download URL is `pub-*.r2.dev` instead of `github.com/releases` (no implicit social proof). Worth fixing before any audience growth. |
| Repo location | `github.com/lukeeexd/Orchestrator`, **public** as of 2026-05-17 | History was rewritten before the privacy flip to scrub personal identifiers. Do not reintroduce real name / personal email anywhere. With v0.15.0 the auto-update path no longer depends on public-repo status — the repo can be flipped private once the R2 channel is verified across a few releases. |

## The fleet (six roles + Director)

| Role | Color | System prompt focus | Default tool set |
|---|---|---|---|
| pm | green | Decompose, sequence, surface dependencies | read-only |
| researcher | blue | Read docs, web fetch, summarise | read + web |
| coder | purple | Read + edit + run tests | read + edit + shell |
| qa | amber | Write/run tests, report failures | read + edit + shell |
| devops | orange | Build, deploy, CI | read + shell |
| security | red | Audit code for vulns / unsafe patterns / leaked secrets | read + shell + web (read-only by default) |

Director itself runs as a long-lived planner-supervisor session. From v0.6.0 it also has its own skill slot, mirroring per-agent skills. Director's operating modes: `auto` (plans + auto-spawns), `manual` (advisor only), and `prd` (emits a structured Product Requirements Doc instead of a plan — v0.13.0).

System prompts live in `src/shared/roles.ts`. Tool allow-lists are per-project per-role overrideable via the Tools screen.

## Deferred / partial features

Items that are still on the table, vs items explicitly tabled. New sessions can pick from `BACKLOG.md` when looking for the next slice — this list is just the longest-running call-outs.

- **Code signing (H7).** Unsigned installer triggers SmartScreen. More important since v0.15.0's switch to the R2 download URL.
- **OS keychain for API keys.** Plain JSON in `userData` is fine for single-user; would matter if we ever ship to others.
- **Session-wide budget.** Per-agent budgets exist; a global "session won't exceed $X" cap (rolling across all agents) doesn't.
- **Wipe session.** `wipeDirector` only clears the Director's chat. A full nuke — agents, log lines, attachments, settings.json `oauthToken` — for handing the machine off is still deferred.
- **Skill marketplace codex integration.** Investigated, deferred. Codex's plugin model (`codex plugin marketplace add/remove`, global state in `~/.codex/config.toml`) doesn't accept a per-spawn `--plugin-dir`. Marketplace screen shows a banner on codex-only projects.
- **Per-agent worktree (P13 path c).** Best candidate identified by the 2026-05-21 spike, blocked on the `claude --resume` cwd-tolerance experiment. See [`docs/spike-2026-05-21-per-agent-worktrees.md`](./docs/spike-2026-05-21-per-agent-worktrees.md).
- **More LLM providers.** Codex shipped as the second provider in v0.5.x. Adding a third (GPT-5 via the standalone API, Gemini, open models) needs a per-provider runner module + tool surface; the runner already branches on `provider` per agent.

## References

- Architecture decisions + locked choices: this file.
- Per-release feature log: [GitHub Releases](https://github.com/lukeeexd/Orchestrator/releases).
- Open work + shipped slices: [`BACKLOG.md`](./BACKLOG.md).
- Process boundaries inside `src/`: [`LAYERS.md`](./LAYERS.md).
- Design handoff (read before any UI work): [`docs/design/README.md`](./docs/design/README.md).
- Hardening notes (May 18 code review): [`docs/hardening-2026-05-18.md`](./docs/hardening-2026-05-18.md).
- Spike notes: `docs/spike-2026-05-21-per-agent-worktrees.md`.

## Historical: v1 milestone log (2026-05-15)

The v1.0 push was a single-day blitz; the per-milestone notes below are kept as historical context. **For everything since v1.0, see GitHub Releases.** This section is frozen.

- **M6 Installer.** `npm run make` produces a working `Orchestrator-Setup.exe` from Forge's MakerSquirrel. Real fight was the SDK's bundled `claude.exe`: bundling a 218 MB native binary isn't possible, externalising puts it in `node_modules` at runtime — but Forge's plugin-vite strips `node_modules` from the package, so a custom `afterCopy` hook plants the SDK platform-binary package + `sql.js` back into the build. asar vs spawn() turned out to be a known Electron gotcha: `fs.existsSync` is asar-transparent but `spawn` isn't. Final v1 shape: drop asar entirely; subsequently restored in v0.2 once the SDK was dropped. Installer is ~200 MB.
- **M5 Budgets + persistence.** Per-agent budgets (dollars, tokens, wall-clock) with hard-stop on the runner side. Tokens accumulate from each assistant message's `message.usage` (including `cache_creation_input_tokens` + `cache_read_input_tokens` — the original miss that hid cached input on Sonnet runs). Session persistence via SQLite schema v2; in-flight agents at shutdown get flipped to `error: Interrupted`.
- **M4 Director.** Plan emission via structured-output (`orchestrator-plan` fenced JSON block, parsed in main, rendered as a card) rather than real MCP tools. Multi-turn via `query({ options: { resume } })`. Single-turn-at-a-time queue serialises user inputs and `[handoff]` notifications. Mode toggle (`auto` / `manual`) landed shortly after; `prd` mode added in v0.13.0.
- **M3 Drawer wired.** Click an agent → live drawer with role-tinted sigil, KPI strip (Step / Tokens / Cost / Elapsed updating each second), and five tabs. Pause action functional (aborts the AbortController). Redirect / Fork / Approve disabled in v1 with hover tooltips; subsequently shipped in v0.3+.
- **M2 Single-agent loop.** Wired the Claude Agent SDK (later dropped in v0.2). Per-agent git worktree (later dropped in v1's last commit — see "Per-agent isolation" decision). Event classifier mapping SDK stream → 7 LogLine kinds. IPC streaming. Flex auth so Team-plan users without API access can run via auto-discovered Claude Code OAuth.
- **M1 UI shell empty-state.** React + Vite plugin wired, full design CSS lifted verbatim (minus mac traffic lights). Component tree under `src/renderer/components/`. Resize widths persist via `useLocalStorageState`.
- **M0 Skeleton.** Forge scaffold reorganised into four-pane src layout (`src/main`, `src/preload`, `src/renderer`, `src/shared`). Typed IPC bridge proves end-to-end. sql.js stood in for better-sqlite3 (no native compile toolchain). Window opens on `--ink` background, first commit on `main`, working branch `dev` pushed.
