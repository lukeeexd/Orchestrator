# Flightdeck — Implementation Plan

Redesigning the Orchestrator main screen from a three-pane list/stream layout into a
spatial **node-graph canvas**: a Director anchor node, agent nodes wired by edges that
show plan fan-out and live handoffs, with pan/zoom, a docked inspector, and a command
input. Target look and information architecture: `docs/redesign/mockups/bold-flightdeck.html`.

This is a **planning document only** — no app code is included. Every claim below is
grounded in the four codebase audits; file:line references are cited inline.

---

## 1. Summary — the paradigm shift

Today the home screen is three stacked panes: a **Director chat** on the left, a vertical
**agents list/stream** in the middle, and a tabbed **Drawer inspector** on the right
(`App.tsx` home conditional; `DirectorPane.tsx:94–234`, `AgentsPane.tsx:37–162`,
`Drawer.tsx:29–129`). The relationship between a Director plan and the agents it spawns —
and between an agent and the agent it hands off to — is *implied by vertical order and
prose*, never drawn. Flightdeck inverts that: the orchestration **becomes the picture**.
The Director is a fixed anchor node, each agent is a card-node positioned by auto-layout,
and edges make the plan fan-out (Director → agent) and live handoffs (agent → agent)
literally visible, with the selected node feeding a docked inspector that reuses the
existing Drawer tabs. Critically, the underlying data and IPC streams **do not change** —
the canvas is a new *render path* over the same `agents[]` and `messages[]` state
(`useAgents.ts:12–94`, `useDirector.ts:21–96`), so it ships as a third view alongside the
working panes rather than a rewrite.

---

## 2. Graph engine decision

**Library: `@xyflow/react` (React Flow) v12.10.2 — MIT.**
**Auto-layout: `@dagrejs/dagre` v3.0.0 — MIT.**

```
npm i @xyflow/react@^12.10.2 @dagrejs/dagre@^3.0.0
# import '@xyflow/react/dist/style.css'
```

Why React Flow and not a hand-rolled SVG canvas:

- It is the only mature, **MIT-licensed**, actively-maintained, React-native node-graph
  library that ships custom nodes/edges, controlled state, built-in pan/zoom/viewport
  (`Background`, `Controls`, `MiniMap`, `fitView`), and automatic resize handling out of
  the box. Custom nodes are plain React components registered via a `nodeTypes` map; custom
  edges via `edgeTypes`, and animated edges (our live handoffs) are first-class
  (`animated: true` or a custom edge component).
- It is **fully offline** — pure client JS, no network, no telemetry, no license server,
  no Pro requirement for the features Flightdeck needs. That satisfies Orchestrator's
  offline-Electron constraint.
- A hand-rolled approach at ~30 nodes is not worth it: we'd re-implement viewport transform
  math, hit-testing, edge routing, zoom-to-fit, and resize observation, then still bolt on
  a layout library. Canvas-vs-SVG only matters past thousands of nodes — irrelevant here.
- **Rejected:** the legacy `reactflow` (v11, frozen — do **not** install by mistake);
  `reaflow` (Apache-2.0, ~4.8 MB, slower cadence, pulls in ELK weight); `elkjs`
  (EPL-2.0 weak-copyleft + ~8 MB — keep as a documented future escape hatch only if we
  later need orthogonal routing or non-tree layouts); `rete`/`reagraph` (wrong interaction
  model).

Why dagre for layout:

- Our graph is a directed **tree/DAG** (Director → agents → handoffs). Dagre is fast, tiny
  to configure (`rankdir: 'LR'` to match the mockup's left-anchored Director fanning
  rightward, or `'TB'`), and is the layout React Flow's own docs recommend for tree fan-out.
- A `useAutoLayout` hook builds a dagre graph from current `nodes`/`edges`, runs
  `dagre.layout()`, and writes the computed `position` back onto each node, feeding real
  rendered dimensions (`node.measured?.width/height` in v12) so spacing respects actual
  card sizes.
- **Layout runs only on topology change** (node/edge added or removed), keyed on a stable
  topology signature (sorted node ids + edge ids) — never on a status tick. This is the
  single most important rule: status changes must not re-trigger layout, or nodes jump.

Bundle cost: ~1.2 MB (React Flow) + ~1.2 MB (dagre) unpacked, tree-shakeable, before
minify/gzip — trivial inside an Electron app already shipping Chromium.

---

## 3. Component architecture

The canvas is a self-contained subtree mounted from `App.tsx`. It reuses existing
presentational components inside its nodes and inspector; only the **layout containers**
(DirectorPane, AgentsPane, Drawer shell) are replaced by canvas-native equivalents — which
matches the audit's reuse breakdown (LogLineRow, PlanCard, PRDCard, Composer, Icon,
ModelPicker, EffortPicker are drop-in; the pane *containers* are layout-only).

### New components

| New component | Responsibility | Reuses (existing) |
|---|---|---|
| `CanvasView` | The `<ReactFlowProvider>` + `<ReactFlow>` host: `Background` (dot grid per mockup), `Controls`/zoom, `MiniMap` optional, registers `nodeTypes`/`edgeTypes` at module scope, holds controlled `nodes`/`edges`, runs `useAutoLayout`, owns selection. Sibling: `InspectorPanel`. | — (new container) |
| `DirectorNode` | The anchor node: recent Director messages + dispatched-plan list + inline command input. Fixed/pinned position. | `Composer` (extracted from `DirectorPane.tsx:491+`), `PlanCard` (`PlanCard.tsx:55–200+`), `PRDCard`, `AttachmentThumb`, `Icon` |
| `AgentNode` | Per-agent card: name, role chip, status tag + pulse, task, Step/Elapsed meta, expand-to-inline-log. `React.memo` with a comparator over the rendered `data` fields. | role tint + status badge + Playwright KPI parser lifted from `AgentRow.tsx:80–112` (as helper fns, not its DOM); `LogLineRow.tsx:25–150` for the inline tail; `Icon` |
| `PlanEdge` (planned) | Director → agent edge; dim when the source plan row is complete, solid otherwise; carries a "step N" port label. | — (custom edge) |
| `HandoffEdge` (live) | Agent → agent edge; `animated` while a handoff is in flight; carries a "handoff" port label. | — (custom edge) |
| `InspectorPanel` | Docked right inspector (mockup `.inspector`, 396px). Header (name/role/status/Step/Elapsed) + the **existing Drawer tabs**. Reads selection via `useStore`/`useOnSelectionChange`; renders from `node.data`. | The **Drawer tab bodies verbatim** — Logs/Tools/Memory/Config (`Drawer.tsx:469–754`), plus Redirect/Fork forms (`Drawer.tsx:261–429`) |
| `CommandBar` | Slim top toolbar from the mockup (run id, model pill, zoom group, "New run"/New agent, mode toggle) + reuse of the global command palette. | `CommandPalette`, `ModelPicker`, `EffortPicker`, mode toggle from `DirectorPane.tsx:295–328` |

### How it slots into App.tsx

- Extend the existing view-mode union (today `'compact' | 'stream'` per `TopBar`/`App.tsx:77`)
  to `'compact' | 'stream' | 'canvas'`, persisted via the existing
  `useLocalStorageState('orchestrator.viewMode', …)` (`App.tsx:77–80`). No new persistence
  mechanism.
- In the home conditional, when `viewMode === 'canvas'`, render `<CanvasView … />` **in place
  of** the DirectorPane + AgentsPane + Drawer trio. Same props the panes already receive —
  `agents`, `selectedId`/`setSelectedId`, `expanded`/`toggle`, `messages`, `send`, `busy`,
  `mode`, and the existing action callbacks (`window.api.redirectAgent`, `forkAgent`,
  `spawnPlan`, abort, etc.). **No new hooks, no main-process changes** for Phases 1–3.
- Global keyboard handlers (`App.tsx:709–725`: Cmd-N spawn, Cmd-K palette, Cmd-. abort,
  Cmd-B drawer) stay; selection-based shortcuts (Cmd-1..9 jump) fall back to Cmd-K palette
  in canvas where there's no fixed visual order.
- Existing modals (CommandPalette, BaseBranchModal, SaveTemplateDialog, PendingRedirectBanner,
  CliMissingGate) render **above** the canvas unchanged — they are already top-level overlays
  in `App.tsx`.

Wrapping the canvas and inspector under one `<ReactFlowProvider>` lets the inspector read
selection/instance state via `useReactFlow`/`useStore` with no prop-drilling.

---

## 4. Data → graph mapping

### Nodes

One graph node per entry in the live `agents[]` array (`useAgents.ts:12–94`), plus one
fixed Director anchor node. Field bindings (all already streamed; `types.ts:121–179`):

| Graph use | Agent field |
|---|---|
| node id (React Flow key) | `id` |
| label | `name` |
| category / role chip + tint | `role` (`subtype` for the Playwright flavour pill) |
| visual state (color, pulse, status tag) | `status` / `statusLabel` |
| progress badge | `step` |
| task text + tooltip | `task` |
| Step/Elapsed meta + inspector stats | `step`, `elapsed`, `startedAt`, `endedAt` |
| origin marker | `spawnedBy` (`'user' | 'director'`) |
| inline/inspector log | `log` (`LogLine[]`, streamed via `onLog`) |
| ancestry edge source | `forkedFromId` / `forkedFromName` |
| redirect capability | `sessionId` |

Per the mockup's explicit constraint, **no cost/token UI** is rendered (`tokens`, `cost`,
`budget`, `modelUsage` exist on the type but are not surfaced on canvas nodes or in the
inspector).

### Edges — and the GAP

Three edge kinds, in order of how cheaply they can be drawn today:

1. **Director → agent (plan fan-out).** *Available, but inferred.* The Director emits
   `plan?: PlanRow[]` in a `DirectorMessage` (`types.ts:203–216`), and each row spawns an
   agent with `spawnedBy: 'director'` (`director.ts` spawn loop, audit lines ~214–305).
   Rows fire sequentially (`await awaitCompletion(prev.id)`), and `PlanRow.i` gives order.
   We can draw fan-out edges by matching `spawnedBy === 'director'` agents to the most-recent
   plan in `messages[]` by name + spawn order. The "step N" port label comes from `PlanRow.i`.

2. **Agent → agent (fork ancestry).** *Fully available.* `forkedFromId` (`types.ts:177`) is
   set once at fork time and immutable — a direct child→parent edge, no inference needed.

3. **Agent → agent (live handoff).** **This is the GAP.** When an agent completes, the app
   builds a `HandoffPayload` (`types.ts:436–447`) and sends it to the **Director's message
   queue** as a `[handoff]` message (`query.ts` ~line 275–288; `director/runner.ts:217–220`).
   It is **not stored as a typed source→target relationship on the agents**. The app has **no
   explicit dependency graph today** — sequence is implicit in the spawn loop, and the
   handoff lives as prose/JSON in the Director chat.

   **Smallest change to populate real handoff edges** (Phase 4, main-process):

   - Add an optional field to `Agent` (e.g. `handoffToId?: string` / `handoffFromId?: string`)
     OR a tiny typed list of `{ sourceId, targetId, at }` handoff records on the run, set
     when the sequential spawn loop launches row *N+1* after row *N* completes (the spawn
     loop already knows both ids at that moment — `director.ts` ~250–305). Broadcast it on
     the existing `onPatch` channel so the renderer needs no new subscription.
   - Until that field exists (Phases 1–3), draw handoff edges **heuristically** from the
     plan-row ordering (row *i* → row *i+1*) and/or by parsing the `[handoff]` Director
     message for the named target — visually correct for the common linear plan, and clearly
     marked as inferred. Phase 4 replaces the heuristic with the typed field.

   Also-missing (out of scope, document as future): parallel-spawn metadata, conditional
   edges, subtask hierarchy, and per-edge cost attribution — none block Flightdeck.

### Live status without re-layout thrash

This is the make-or-break detail. React Flow re-renders a node only when **that node's
object reference changes**.

- **Controlled state.** Hold `nodes`/`edges` via `useNodesState`/`useEdgesState`. On a
  status event, update **only the affected node** immutably
  (`setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, status } } : n))`);
  every other node keeps its reference and React Flow skips it.
- **Mutating fields live in `node.data`** (status, step, elapsed, last log line), read inside
  the memoized `AgentNode`.
- **Coalesce IPC bursts.** `onLog`/`onPatch` can fire rapidly (`query.ts:224,256`). Buffer
  events and flush one `setNodes` per `requestAnimationFrame` (~60–100 ms batch) instead of
  one per IPC message — the biggest perf lever.
- **Live = the edge, not the node position.** Flipping `edge.animated` on the active handoff
  is cheap; never drive position from status.
- Define `nodeTypes`/`edgeTypes` at module scope (React Flow warns about re-creating them per
  render). Avoid the four known anti-patterns: recreating the whole `nodes` array each tick,
  re-running layout on status, unmemoized nodes, per-render `nodeTypes`.

---

## 5. Preserving functionality

Every must-keep capability from the inventory survives. Mapping (citations are current
locations being reused or relocated):

| Capability (current location) | Place in canvas view |
|---|---|
| Director chat + history (`DirectorPane.tsx:195–222,384–405`) | Scrollable body of the `DirectorNode` (mockup `.dir-body`) |
| Composer: textarea, @mention, slash + help, attach/drag/paste, Ctrl-Enter (`DirectorPane.tsx:491–939`) | `Composer` extracted into `DirectorNode` input + a docked command input (mockup `.dir-input`) |
| Plan cards: accept/spawn, edit/drop rows, save-as-template (`PlanCard`, `DirectorPane.tsx:462–470`) | Rendered inside `DirectorNode` ("dispatched plan" block); fan-out edges visualize the spawns |
| PRD card (`PRDCard`) | Inside `DirectorNode` body |
| Mode toggle auto/manual/prd (`DirectorPane.tsx:295–328`) | `CommandBar` toolbar |
| Director model/effort/provider, auto-branch toggle (`DirectorPane.tsx:145–177`) | `CommandBar` toolbar controls |
| Rewind to message (`DirectorPane.tsx:437–445`, `App.tsx:801–823`) | Context menu on a Director message row |
| Wipe Director (`DirectorPane.tsx:184–232`) | `CommandBar` / palette action |
| Attachment chips (`DirectorPane.tsx:447–454`) | Inline with the command input |
| Pending redirect banner + cancel (`App.tsx:962–968`) | Floating banner overlay (unchanged top-level) |
| View toggle compact/stream/**canvas** (`TopBar`, `App.tsx:77`) | `CommandBar` / TopBar (adds the third option) |
| Agent name, role, status, step, task, Playwright KPI (`AgentRow.tsx:80–112`) | `AgentNode` head + meta |
| Agent expand/collapse inline log (`AgentRow.tsx:140–151`) | `AgentNode` expand button → inline `LogLineRow` tail (mockup `.node-log`) |
| Agent abort / remove (`AgentRow.tsx:113–137`) | `AgentNode` context menu / header action |
| Agent selection + keyboard (`AgentsPane.tsx:113–145`) | Click/keyboard focus → selection highlight + inspector; Cmd-1..9 falls back to palette |
| New agent (Cmd-N) (`AgentsPane.tsx:79`, `App.tsx:709`) | `CommandBar` button + existing `SpawnAgentForm` modal over canvas |
| Focused fix (`AgentsPane.tsx:72–78`) | `CommandBar` / palette command |
| Active agent count (`AgentsPane.tsx:53–69`) | Status rail (mockup footer) |
| Onboarding banner (`AgentsPane.tsx:85–91`) | Dismissable overlay |
| Drawer collapse (B key) (`Drawer.tsx:46–62`, `App.tsx:722`) | `InspectorPanel` collapse / close |
| Agent header: name/role/model/status/Step/Elapsed (`Drawer.tsx:146–259`) | `InspectorPanel` head + stats (Step/Elapsed only — no cost/token) |
| Pause/abort (`Drawer.tsx:193–201`) | `InspectorPanel` header action |
| Redirect button + form w/ model/effort (`Drawer.tsx:202–215,346–429`) | `InspectorPanel` (reused verbatim) |
| Fork button + form (`Drawer.tsx:216–229,261–344`) | `InspectorPanel` (reused verbatim) |
| Approve button (stub) (`Drawer.tsx:230–236`) | `InspectorPanel` + approval state on `AgentNode` (mockup `s-appr`) — **needs UX design before Phase 3** |
| Logs / Tools / Memory / Config tabs + arrow nav + counts (`Drawer.tsx:95–127,469–754`) | `InspectorPanel` tabs (reused verbatim) |
| Memory approve/reject (`Drawer.tsx:642–659`) | `InspectorPanel` Memory tab (reused) |
| Command palette Ctrl-K (`App.tsx:957–961`) | Global modal (unchanged) |
| Global shortcuts (`App.tsx:709–725`) | Stay global; selection-based ones adapt to canvas focus |
| Project tabs (`App.tsx:746–753`) | Unchanged above the canvas / `CommandBar` |
| Rail screens (`LeftRail`) | Unchanged (canvas is one rail screen) |
| Marketplace toast (`App.tsx:931–945`) | Toast overlay (unchanged) |
| Base-branch modal (`App.tsx:970–976`) | Modal (unchanged) |
| CLI-missing gate (`App.tsx:1018–1027`) | Blocking overlay (unchanged) |
| Update pill | Status rail (mockup footer) |

The one capability with **no existing UX pattern** is the **Approval gate** (`Drawer.tsx:230–236`
is a disabled placeholder). The mockup shows an `approval` node state (`s-appr`, burnt-amber).
Decide its interaction before Phase 3 to avoid an awkward retrofit (see Open decisions).

---

## 6. Rollout strategy (NON-NEGOTIABLE: do not break the working app)

The canvas ships as a **third view alongside the existing panes**, behind the existing
view-mode toggle — built incrementally; the pane view stays the default until the canvas is
at parity.

- Add `'canvas'` to the `viewMode` union and a third toggle option in `TopBar`/`CommandBar`.
  Default stays `'compact'`; the canvas is opt-in (and gated behind a feature flag in early
  phases so an unfinished canvas can't be reached in a release build).
- When `viewMode !== 'canvas'`, **zero code paths change** — DirectorPane/AgentsPane/Drawer
  render exactly as today. The canvas is purely additive.
- The canvas consumes the **same state and IPC** as the panes (`useAgents`, `useDirector`),
  so both views stay live and correct simultaneously — switching the toggle is free.
- Promotion to default (Phase 5) is a one-line default change, fully reversible. No data
  migration, no main-process behavior change for Phases 1–3 (only Phase 4 adds an optional,
  backward-compatible handoff field).

---

## 7. Phased delivery

Sized to the project's "one minor per couple of days" cadence — each phase is a shippable,
flag-gated slice that leaves the pane view untouched.

### Phase 1 — Read-only canvas mirroring live state (one minor; ~2 days)
Install React Flow + dagre. Build `CanvasView`, `DirectorNode` (display-only: messages +
plan list, no input yet), `AgentNode` (status/step/task/meta, pulse), dot-grid `Background`,
zoom `Controls`, status rail. Wire `agents[]`/`messages[]` → nodes. Implement `useAutoLayout`
(dagre, topology-keyed) and the rAF-batched per-node status updates. **Outcome:** open canvas,
watch the live fleet render and update; no interaction beyond pan/zoom. *Effort: foundational
but bounded — the data already flows.*

### Phase 2 — Selection + docked inspector (one minor; ~2 days)
Selection highlight on `AgentNode`; mount `InspectorPanel` reusing the **existing Drawer tab
bodies verbatim** (Logs/Tools/Memory/Config) and header stats (Step/Elapsed). Wire
selection ↔ `selectedId` and `useOnSelectionChange`. Inline node-log expand reusing
`LogLineRow`. **Outcome:** click a node, inspect it exactly like the Drawer today. *Effort:
mostly wiring + reuse; low new surface.*

### Phase 3 — Interactions: redirect / fork / approve + command input (one minor; ~2–3 days)
Extract `Composer` into `DirectorNode` and the docked command input; reuse Redirect/Fork
forms in the inspector; node context menus for abort/remove/rewind; `CommandBar` with mode +
model/effort + New agent + palette. Design and wire the **Approval gate** (the one new UX).
**Outcome:** canvas is operationally usable end-to-end. *Effort: the densest phase — most
reused-component plumbing + the new approval pattern.*

### Phase 4 — Edges, handoff flow + layout polish (one minor; ~2–3 days)
Plan fan-out edges (Director → agent, "step N" labels), fork ancestry edges, and the GAP
fix: add the optional `handoffToId`/`handoffFromId` (or handoff-record) field in the main
process + broadcast on `onPatch`, replacing the Phase-1 heuristic with real source→target
handoff edges; `animated` live edges; layout spacing/fit polish; reduced-motion handling.
**Outcome:** the orchestration is fully drawn and live. *Effort: includes the one
main-process change — backward-compatible, gated.*

### Phase 5 — Make it the default (one patch/minor; ~1 day)
Remove the feature flag, flip default `viewMode` to `'canvas'`, keep compact/stream as
selectable fallbacks (decision pending — see §9). Docs, release notes, a11y pass.
**Outcome:** Flightdeck is the main screen, panes retained as alternates. *Effort: small,
mostly verification.*

---

## 8. Risks + mitigations

- **Re-layout thrash on status ticks** (highest risk). Status updates jumping node positions
  would make the canvas unusable. *Mitigation:* layout runs only on topology change
  (topology-signature key), status lives in `node.data`, per-node immutable updates, rAF
  batching. This is the core engineering discipline of Phase 1.
- **Perf at ~30 nodes.** A non-issue if the four anti-patterns are avoided (whole-array
  identity churn, layout-on-status, unmemoized nodes, per-render `nodeTypes`). React Flow
  handles hundreds of SVG nodes; 30 memoized cards with batched updates is well within budget.
- **Window resize.** React Flow's internal ResizeObserver reflows automatically; give the
  container `100%`/flex height. Preserve viewport transform across resize (better UX than
  auto-refit); optional debounced `fitView`. Verify against Electron window resize +
  resizable panes.
- **Edge-data gap.** The app has no explicit dependency graph; handoff is prose in the
  Director chat. *Mitigation:* heuristic edges from plan-row order in Phases 1–3, then the
  smallest backward-compatible main-process field in Phase 4. No edges are "wrong," only
  "inferred until Phase 4."
- **New dependency.** Two new packages in an offline Electron app. *Mitigation:* both MIT,
  no network/telemetry/license server, no Pro tier needed; pin `^12.10.2` / `^3.0.0`; avoid
  the frozen legacy `reactflow` and the EPL-2.0 8 MB `elkjs`.
- **Bundle size.** ~2.4 MB unpacked added, tree-shakeable — trivial inside Chromium.
- **Canvas accessibility.** A node graph is harder for keyboard/AT than a list. *Mitigation:*
  keep the global palette (Cmd-K) as the spatial-agnostic entry; ensure tab order into the
  inspector; honor `prefers-reduced-motion` (the mockup already disables edge dash + pulse
  under it); the pane views remain available as the accessible fallback while canvas matures.
- **Approval-gate UX is undesigned.** `Drawer.tsx:230–236` is a stub. *Mitigation:* design it
  in Phase 3 before wiring; the mockup's `s-appr` node state is the visual starting point.

---

## 9. Decisions (locked 2026-05-28)

These were the open forks; all are now locked as working assumptions. Any can be revisited
before the phase that depends on it, but the build proceeds on these unless changed.

1. **Keep both views long-term: YES.** The compact/stream panes stay as permanently
   selectable views (safety net + accessibility fallback) through at least one release after
   the canvas reaches parity. The canvas does not delete the panes.
2. **Edge/handoff data: MINIMAL.** Phase 4 adds a minimal `handoffFromId`/`handoffToId` on
   `Agent`, broadcast on the existing `onPatch` channel. Plan rows also record their spawned
   agent id at spawn time so Director-to-agent fan-out edges are exact rather than
   name-matched. Richer typed handoff records (timestamps, payload ref) are deferred.
3. **Library: CONFIRMED.** `@xyflow/react@^12.10.2` + `@dagrejs/dagre@^3.0.0` (MIT/MIT,
   ~2.4 MB). `elkjs` explicitly declined for now (kept only as a future escape hatch).
4. **Approval-gate interaction: INSPECTOR BUTTONS.** Approve/reject live as actions in the
   docked inspector for the selected node (not a node-overlay action and not a modal).
5. **Default layout direction: LR.** Director on the left, agents fan rightward (matches the
   mockup).
