# Orchestrator — Layers

This file documents the project's architectural layers and the rules that
keep them from drifting back into monoliths. The boundary rules are
enforced by `import/no-restricted-paths` in `.eslintrc.json`; this doc
explains the *why* + the sub-layer conventions that the linter can't
encode automatically.

## Process layers

Electron splits the app into three runtime contexts. The fourth (`shared`)
is process-agnostic code that runs in any of them.

```
┌─────────────────────────────────────────────────────────────────┐
│  src/renderer/  — React + DOM, runs in a Chromium tab           │
│      ▲                                                          │
│      │ window.api  (contextBridge)                              │
│      ▼                                                          │
│  src/preload/   — sandboxed bridge; ipcRenderer.invoke only     │
│      ▲                                                          │
│      │ IpcChannels (shared)                                     │
│      ▼                                                          │
│  src/main/      — Node + Electron APIs, single process          │
│                                                                 │
│  src/shared/    — types, constants, enums, IPC contract         │
│                   reachable from any of the above               │
└─────────────────────────────────────────────────────────────────┘
```

The crossing rules:

| From          | To            | Allowed? | Why                                                            |
| ------------- | ------------- | -------- | -------------------------------------------------------------- |
| renderer      | main          | ✗        | Use `window.api` via preload                                   |
| renderer      | preload       | ✗        | Preload's exports reach the renderer only via `contextBridge` |
| main          | renderer      | ✗        | Renderer code is React + DOM; won't load in main               |
| main          | preload       | ✗        | Preload runs in a separate sandbox with its own entry         |
| preload       | main          | ✗        | Preload bridges via `ipcRenderer.invoke` against `IpcChannels` |
| preload       | renderer      | ✗        | Preload mounts before the renderer                             |
| shared        | main          | ✗        | shared/ must stay process-agnostic                             |
| shared        | renderer      | ✗        | shared/ must stay process-agnostic                             |
| shared        | preload       | ✗        | shared/ must stay process-agnostic                             |
| any           | shared        | ✓        | shared/ is the contract layer                                  |

The linter rule is the safety net — these are the bugs it prevents.
The most common attempt: a renderer component importing a function from
`src/main/...` because the type signature looks useful. Compiles in TS,
crashes at runtime because the main module's `require('node:fs')` won't
resolve in a Chromium renderer. Catching it at lint time is faster than
discovering it after `npm run package`.

## Sub-layers within src/main/

The main process owns the most code and the most opportunity for drift
into monoliths. After the v0.10 / v0.11 splits (S1 marketplace, S2 ipc,
S7 runner) the convention is:

**One domain per directory.** When a top-level file in `src/main/`
crosses ~500 lines and represents one coherent concern, split it into a
directory with:

- A **barrel** (`index.ts` or the directory name `.ts`) that re-exports
  the public API. Callers in other modules import from the directory,
  not from the internal files.
- One file per **entry point**. The agent runner has spawn / fork /
  redirect / abort; each lives in its own file alongside its private
  executor.
- A shared **internal helpers** file (`internal.ts`) for cross-cutting
  utilities used by multiple entry points (state shapes, build helpers,
  small constants). Not re-exported from the barrel.
- A shared **core** file when multiple entry points funnel through the
  same heavy logic (`query.ts` in the agents layer holds buildQuery +
  consumeQuery — the loop every spawn type drains).

Current shape:

```
src/main/
├── agents/          spawn, fork, redirect, abort, query, internal,
│                    skillFires, classifier, registry, handoffPayload,
│                    agent-lock
├── cli/             provider-specific CLI invocation (claude, codex)
├── director/        session management + system prompt + parse
├── ipc/             one file per channel domain (agents, projects,
│                    marketplace, templates, director, attachments,
│                    settings, misc, app) + _shared / _schemas
├── marketplace/     sources, subscriptions, loadout, telemetry,
│                    internal
└── security/        workspace / attachments / mcp path-safety guards
```

Top-level files in `src/main/` are singletons whose scope is small
enough not to warrant a directory: `db.ts`, `settings.ts`,
`persistence.ts`, `projects.ts`, `attachments.ts`, `commands.ts`,
`history.ts`, `skills.ts`, `spend.ts`, `updater.ts`, `templates.ts`,
`skillAudit.ts`, `loadoutInsights.ts`, `spendRecommendations.ts`,
`index.ts` (entry point).

## When to split a top-level file

Heuristics, not hard rules:

- File crosses **500 lines** and contains > 2 conceptually-distinct
  groups of functions.
- Multiple entry-point functions share a long helper but the file is
  hard to grep for "where does the spawn path actually start".
- `project_architect.py` from `engineering-skills:senior-architect`
  flags it in a measurement pass.
- A new feature would naturally widen it further (e.g. P1 templates
  would have added another 400 lines to a monolithic `persistence.ts`
  — better to give templates its own file before that).

When you split: preserve the public API via a barrel. Every existing
caller should keep working without a single import path change. The
S1, S2, S7 commits are templates for the pattern.

## When to NOT split

- File is under 500 lines and has one coherent concern. Splitting
  prematurely adds import overhead and makes the file tree harder to
  scan.
- Functions are tightly coupled and would force lots of internal
  re-exports across the split. The cross-module surface area beats
  the in-file scrolling cost.
- The "domain" you'd extract has one entry point and three helpers.
  That's a file with sections, not a layer.

## Renderer sub-layers

Less formal than main, since the renderer is React-shaped:

- `src/renderer/components/` — one component per file
- `src/renderer/hooks/` — `useXxx` hooks; cross-cutting state
- `src/renderer/lib/` — pure utilities
- `src/renderer/App.tsx` + `index.tsx` — entry

No per-domain split inside `components/` — flat works at the current
file count (~30). Revisit if it crosses ~80.

## Sharing the contract

The IPC contract lives entirely in `src/shared/ipc.ts` — both
`IpcChannels` (the runtime string keys) and `OrchestratorApi` (the
TypeScript surface). Adding a new channel touches three files in
order:

1. `src/shared/ipc.ts` — add the `IpcChannels.XxxYyy` key + the
   `xxxYyy(...) => Promise<...>` field on `OrchestratorApi`.
2. `src/main/ipc/<domain>.ts` — register the handler with
   `ipcMain.handle(IpcChannels.XxxYyy, ...)` or wrap with `validated()`
   for object-payload channels (S2's zod boundary).
3. `src/preload/index.ts` — add the `xxxYyy: (...) => ipcRenderer.invoke(IpcChannels.XxxYyy, ...)` entry.

That's the pattern; nothing else should reach across the boundary.

## Where layer convention BREAKS DOWN today

Honest notes on what's not clean yet:

- `src/main/director/runner.ts` is still a 600-ish-line file that
  combines session management + plan acceptance + handoff queuing.
  Less acute than the runner.ts that S7 split (no shared executor
  across multiple entry points), but a candidate for a future S7-shape
  carve.
- `src/main/persistence.ts` (~500 lines) glues all the table-write
  paths together. Could split per-table if it grows further.
- The `cli/` and `security/` directories don't have barrels — they
  expose multiple named exports flat. Fine for their current size;
  would want barrels if either grows past ~3-4 files.

These aren't bugs — they're heuristics the lint rule can't catch, and
the right move is to address them when they actually start to bite,
not preemptively.
