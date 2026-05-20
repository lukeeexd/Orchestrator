# Hardening pass — 2026-05-18 code review

Landed on `dev` as 9 themed commits on 2026-05-20, derived from the review in
`C:\Users\Luke\Documents\code-review-2026-05-18.md` (not checked in — local
review artifact).

**Audience:** future agents working in this codebase. The notes below favour
"what invariants exist now" over "what bug got fixed." Read this before
touching the runner, IPC layer, settings file, attachment pipeline, or
forge config.

## New invariants

These are the rules the hardening pass put in place. Don't quietly relax
them — the bugs they prevent are non-obvious failure modes (sequential
plan stalls, silent agent state corruption, exfiltration through the
attachment pipeline).

### Per-agent lock around runner entry points

`src/main/agents/agent-lock.ts` exports `withAgentLock(id, fn)`. Every
runner entry point that mutates an agent's status / controller /
completion tracker must hold the lock:

- `spawnAgent` — no contention possible on a fresh id, so it skips the
  lock and goes straight to `trackCompletion`.
- `redirectAgent` — locks on `req.agentId`. Two concurrent redirects
  in the same tick used to both pass the `'running'` guard; now they
  queue.
- `forkAgent` — locks on the **parent** id during sessionId read.
- `abortAgent` (new export in `runner.ts`) — locks on the id. The
  `AgentAbort` IPC handler routes through it instead of calling
  `registry.abort` directly.

Pair this with `trackCompletion(id, work)` from the same module. The
old `setTimeout(60s)` cleanup carried an orphan-timer bug that deleted
the wrong entry when redirect overwrote the map; the new tracker is
generation-tagged.

### Workspace pinning at the IPC boundary

`src/main/security/workspace.ts` defines `assertValidWorkspacePath` and
`assertWorkspaceMatchesProject`. Any IPC handler that takes a workspace
path (`AgentSpawn`, `AcceptPlan`, `ProjectCreate`, `ProjectSetWorkspace`)
must route through one of these. The spawn handlers require an *exact
match against the project's stored workspace* — a compromised renderer
cannot redirect a spawn into `C:\Users\` or a UNC mount.

UNC, device-namespace (`\\?\`, `\\.\`), home-relative (`~`), root-only
(`C:\`), and non-existent paths are rejected outright.

### Attachment allow-list

`src/main/security/attachments.ts` maintains a per-session
`Set<string>` of paths the user surfaced via a user-gesture IPC call:

- `AttachmentPick` (file dialog) — adds picked paths.
- `AttachmentSavePaste` — adds the temp file it wrote.
- `AttachmentDescribePaths` (drag-drop) — adds dropped paths.

The runner (`prepareAttachments` in `attachments.ts`) filters every
request through `isAttachmentAllowed` and skips anything not in the
set with a warning. `AttachmentReadThumb` does the same check so a
compromised renderer cannot exfiltrate arbitrary local files as data
URLs.

Also enforced by `prepareAttachments`:
- 2 MiB total inlined text across all text attachments per call.
- 32 attachments per call hard cap.

### MCP-config command audit trail

`SetProjectMcpConfig` IPC parses `mcpServers[*].command`, returns the
list in its response, and pushes a Director system message naming the
commands. `ProjectPreviewMcpConfigCommands` is a separate handler the
renderer can call before commit to show a confirmation step. The
mirror file write now `throws` on failure instead of swallowing — the
IPC handler turns it into `{ ok: false, error }`.

### Settings secrets encrypted at rest

`src/main/settings.ts` encrypts `apiKey` and `oauthToken` via
`safeStorage` (DPAPI on Windows) on every write. Legacy plaintext
values flow through unchanged and re-encrypt on next write. The
in-memory `cached` Settings still holds plaintext — consumers don't
need to decrypt per read.

### Marketplace tarball safety

`syncSourceViaTarball` now post-extract-validates that no path
realpath-resolves outside the extract root. Microsoft's bsdtar on
Win10+ already rejects `..` entries, but a GNU tar in the user's PATH
(msys/WSL passthrough) would follow them. The fetch + write +
extract is also wrapped in one `try/finally` so a throw mid-write
doesn't orphan the partial tarball.

### `materializeSubset` is cached

`marketplace.ts` keys the synthetic plugin-dir on `(scope, role,
sourceId, bundleId)` and stores `(bundleMtimeMs, hash(skills))` per
key. Subsequent calls skip the `rm + cpSync` rebuild when nothing
changed — closes a race where two parallel spawns of the same role
could each rebuild and ENOENT each other.

### BrowserWindow hardening

`src/main/index.ts` sets `sandbox: true`, `webSecurity: true`,
`allowRunningInsecureContent: false`. `setWindowOpenHandler` denies
`window.open`; `will-navigate` refuses anything outside the
dev-server URL. A `file://` link in rendered agent output can no
longer navigate the main window away.

### Shared `<Modal>` wrapper

`src/renderer/components/Modal.tsx`. Provides focus trap, Escape
close, `role="dialog"` + `aria-modal` + `aria-labelledby`, initial
focus on first tabbable, focus restoration on unmount. Every modal
in the app (`CliMissingGate`, `SpawnAgentForm`, `ConfirmDeleteProject`,
`AddSourceModal`, `LoadoutModal`, `SkillPreview`, `ChangelogModal`,
`RecommendedSetup`) goes through it. Don't write a new modal from
scratch — extend `<Modal>` or pass `panelClassName` for screen-specific
styling.

### Shared `ROLE_TINT` / `STATUS_TINT`

`src/shared/roles.ts` is the single home for both. Also exports
`AGENT_ROLE_ORDER` (canonical iteration order) and adds a `tint`
field to each `RoleDefinition`. Don't redefine these per-component
— the previous review caught real drift (one STATUS_TINT was missing
`approval`; `SpawnAgentForm` had a shadow `ROLES` array).

### `buildQuery` unifies the three runner flows

`runner.ts:buildQuery({...})` is the shared core of `run` / `runFork` /
`runRedirect`. CLI selection, role-prompt assembly, plugin-dir + MCP
config wiring, the `agents.main` block — all in one place. The
callers still own their own prompt preludes (workspace context for
`run`, fork notice for `runFork`, "Continuing task" for
`runRedirect`).

Two pre-existing drifts were folded in:
- Plugin-dir diagnostic note now fires for fork/redirect too (via
  `emitPluginDirsNote`; only `run` opts in to avoid the redundant log
  for resumed sessions).
- Codex forks now include the project skill body in the role
  preamble (used to use `role.systemPrompt` only).

## New files

| Path | Purpose |
|---|---|
| `src/main/agents/agent-lock.ts` | Per-agent mutex + generation-tagged completion tracker. |
| `src/main/security/workspace.ts` | Workspace-path validation. |
| `src/main/security/attachments.ts` | Per-session attachment allow-list. |
| `src/main/security/mcp.ts` | MCP-config command extractor. |
| `src/renderer/components/Modal.tsx` | A11y-correct modal wrapper. |
| `docs/hardening-2026-05-18.md` | This file. |

## Renamed / contract-changed IPC

If you're touching the IPC surface, these moved:

- `AcceptPlanResponse`: `spawnedAgentIds: string[]` → `firstSpawnedAgentId: string | null`. The array always carried ≤ 1 because rows 2..N spawn in a detached loop; the new shape stops misleading callers.
- `setProjectDirectorEffort` param: `EffortLevel` → `EffortLevel | null` (matches the main-side handler).
- `MarketplaceSubscriptionView.roles`: `string[] | null` → `Array<AgentRole | 'director'> | null`. The IPC layer narrows by filtering through a known role set on the way out.
- `SetProjectMcpConfig` response: now `{ ok, error?, commands? }` — extra `commands` field.
- New `previewMcpConfigCommands(config)` IPC handler.
- `DirectorAckRedirectRequest` is now a named interface in `shared/ipc.ts` (was inlined in three places).
- Removed: parameterless `getClaudeCliStatus` / `AppCliStatus`. Use `getCliStatus('claude')` instead.
- Removed: duplicate `SpawnAgentResponse` in `shared/types.ts`. Single home: `shared/ipc.ts`.

## DB / persistence behaviour

- `agent.log` in memory caps at the trailing 2000 lines (`LOG_TAIL_CAP`). Disk holds the full history. Use `persistence.listLogLinesForAgent(agentId, limit, beforeSeq?)` to fetch older slices on demand (e.g. when the Drawer opens).
- Startup hydration tails to 2000 per agent (`LOG_TAIL_HYDRATE_CAP`). `logSeq` is seeded from `MAX(seq)` so `appendLogLine` doesn't reuse seqs.
- `LogLine.msg` parsing uses the `kind` discriminator (`kind === 'tool'` → `JSON.parse`; otherwise raw string). The previous `startsWith('{')` heuristic is gone.
- `saveDb()` is now async (`fs.promises.writeFile`) with save coalescing. `closeDb()` stays synchronous for the `before-quit` path.
- `setProjectMcpConfig` asserts UUID-shape on the project id before joining into the userData path, and throws on write failure (was swallowed).

## Codex CLI

- Synthesises a `result/no_terminal_event` event on `close(code=0)` when no `turn.completed` was seen. Agent reaches a terminal status instead of hanging in `'running'` forever.
- Trailing-buffer JSON goes through `translate()` so a final `turn.completed` in the buffer still produces the proper result event.
- `[codex raw]` stderr firehose now gated behind `DEBUG_CODEX_RAW` env var. Off by default — flip when investigating "(empty response)" reports.

## Rates table

`shared/rates.ts` now normalises model ids before the `RATES[]` lookup:
strips bracket-style beta annotations (`claude-opus-4-7[1m]`), the
internal `-1m` pseudo-suffix, and dated suffixes like `-20251001`.
Closes a silent fall-through to the Sonnet fallback rate for Opus
4.7 1M.

## Renderer state hazards (M10)

If you're working in `App.tsx`:

- The `handledPlans` / `handledRedirects` refs are now cleared on
  project switch.
- `useAgents.expanded` is cleared on project switch too.
- The auto-mode redirect effect uses a high-water-mark via
  `prevModeRef`: flipping manual → auto marks every existing redirect
  as handled before the auto-fire effect runs, so the user doesn't
  burst-fire a backlog by changing modes.
- The agent-count refresh function is hoisted out of the
  `setAgentCountByProject` updater. React updater functions must be
  pure; the old shape did an IPC call inside the updater and StrictMode
  dev fired it twice.

## Authenticode signing — dormant scaffold

`forge.config.ts` has an opt-in `windowsSign` block keyed on
`WINDOWS_SIGN_CERT_FILE` + `WINDOWS_SIGN_CERT_PASSWORD` env vars.
The user has decided not to acquire a cert (see
`stability-landmines` memory). The block stays dormant — falls
through unsigned for both local dev and release builds.

**Consequence:** the installer + auto-update payload ship unsigned.
ASAR-integrity fuses can't usefully come on without signing first, so
they're effectively pinned off. Don't re-propose either as a backlog
item.

## Explicitly deferred — do not re-propose

These were considered and intentionally parked. If a future review or
session proposes them, point at this section first.

- **H6 worker_threads for DB export.** Phase 3 moved the file write
  off main via `fs.promises.writeFile`; the remaining cost is
  `dbInstance.export()` itself, which at realistic DB sizes (≤10 MB
  after the H5 in-memory log cap) is ~5–20 ms. Doing it properly
  needs the whole sql.js Database in a worker and all 43 `getDb()`
  call sites made async — 3–5 hour refactor for marginal gain at
  current usage shape. Revisit only if a real install demonstrates
  `export()` blocking >100 ms.
- **H7 cert.** See "Authenticode signing" above.
- **L1 large file splits.** `ipc.ts` (~1000 LOC), `marketplace.ts`
  (~1700 LOC), `MarketplaceScreen.tsx` (~2400 LOC) are tractable but
  pure hygiene — no behaviour change. The high-value drift surfaces
  (tints, runner) were already covered in this pass.

## Commit map

| Commit | Theme | Findings closed |
|---|---|---|
| `adbe50c` | Per-agent lock + completion tracker | C1, H2, H4, M6, M8 |
| `3d4c308` | Security hardening at the IPC boundary | C2, H3, M2, M3, M4, M5, L2 |
| `b1d6bea` | Runner survives bad states | H1, H5, H6 (partial), M7 |
| `785985f` | Renderer perf + a11y pass | H8, H9, H11, M10, M11, M12 |
| `79977be` | Tighten IPC contracts + drop dead surface | H10, M13, L4 |
| `5c596ac` | Misc hardening + polish | M1, M9, M14, L3 (partial) |
| `151f54f` | Authenticode signing scaffold | H7 (dormant) |
| `546866e` | One home for role + status tints | L1 (partial) |
| `e5ab6a7` | `buildQuery` helper unifies runner flows | L1 (partial) |

SHAs are post-rebase (rebased onto `81dd20b chore: bump version to
0.9.0` before push). Pre-rebase SHAs live on the deleted
`hardening/code-review-2026-05-18` branch reflog if needed.
