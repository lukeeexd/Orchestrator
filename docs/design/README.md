# Handoff: Orchestrator for Agent LLMs

A desktop application that lets you run an LLM **Director** which chats with you and spawns specialised **agents** (researcher, coder, QA, PM, devops) to carry out the work. You watch every agent's live structured log, inspect its tools/memory/context, and approve/redirect/fork it from a right-side detail drawer.

---

## About the design files

The files in `design-reference/` are **design references created in HTML+React** — prototypes showing the intended look, structure, and behavior. They are **not production code to copy directly**.

Your task is to **recreate this UI in the target codebase's existing environment**: if it's a desktop app, use Tauri/Electron + the framework already in play; if a web app, use the existing React/Vue/Svelte stack and component library. If no codebase exists yet, choose what's appropriate (recommended: **Tauri + React + TypeScript** for a desktop orchestrator — small bundle, native window chrome, fast).

All data in the reference is **empty by design** (`data.jsx` exports empty arrays and `null` session). Populated states are shown in `screenshots/` for visual reference. Wire up real data from your orchestrator runtime.

## Fidelity

**High-fidelity.** Colors, type, spacing, and interactions are final. Recreate pixel-perfectly using the codebase's component library where possible, falling back to bespoke CSS for the dense terminal-style chrome.

---

## Application shell

A single full-viewport window. From top to bottom:

| Region        | Height       | Notes |
|---------------|--------------|-------|
| Top bar       | 38px         | Traffic lights · project crumb · token/cost pills · model selector · pause/resume |
| Body          | flex 1       | Three vertical panes separated by **draggable resize handles** |
| Status bar    | 24px         | Connection · session id · elapsed · context budget · keyboard hints |

The body has 4 columns: **Left rail (52px) · Director (resizable 300–640, default 400) · Agents (flex) · Drawer (resizable 340–680, default 460)**.

Drawer is toggleable from Tweaks. Resize handles glow accent-green on hover, snap to min/max.

### Screens

There is only one screen — a live single-pane orchestrator. Additional screens implied by the rail nav (Templates, Spend, Runs, Settings) are out of scope for this handoff but should slot into the center pane when their rail item is active.

---

## Panes

### Director chat (left)

A normal chat interface, but the assistant is the Director — an LLM that plans, delegates, and supervises. Messages are typed:

- **user** — what you sent (name in `text` color)
- **director** — LLM responses (name in accent green)
- **system** — automated notes like "Spawned 6 agents" (name in cyan)

Director messages can embed a **plan card**: a numbered tree showing which agents will be spawned with what tasks. The plan is editable before the user confirms (`accepted` badge).

The composer sits at the bottom: textarea + chip row (attachments, branch, `@agent` mention). Send on `↵`, newline on `⇧↵`.

**Empty state:** centered glyph + "Awaiting your first task" + three example-prompt chips.

### Agents workspace (center)

A scrollable list of every agent in the current session.

Each row has a 44px header strip:
`chevron | status dot | name/role | current step + task | tokens | cost | pause`

Click the chevron to expand the row inline and reveal a structured log:
```
12:04:18.221  THOUGHT   Free text reasoning
12:04:18.451  TOOL      read_file(path="src/index.ts")
12:04:21.118  RESULT    32 KB returned · indexed
12:04:24.880  NOTE      Pinned: schema migration needed
12:04:28.110  WARN      2 of 6 tests failed
12:04:36.220  HANDOFF   Brief sent to coder-02
```

Each `kind` has its own muted-but-distinct accent (see Design tokens). Tool calls are syntax-highlighted: `fn` in green, `arg` keys in default text, `"strings"` in amber.

Above the list: filter chips (all / running / waiting / done) with counts, an "All logs" button, and a primary "New agent" button.

**Empty state:** "No agents running" + buttons to create one or pick from a template.

### Detail drawer (right)

When an agent is selected, the drawer shows:

1. **Header** — sigil + name + role + status pill
2. **KPI strip** — Step · Tokens · Cost · Elapsed (4 tiles)
3. **Action row** — Pause · Redirect · Fork · Approve
4. **Tabs** — Logs · Tools · Memory · Context · Config

**Logs tab:** current task, who spawned it, last 8 log lines.

**Tools tab:** every tool granted to the agent, with namespace prefix (`fs.read_file`), invocation count, and last-used relative time.

**Memory tab:** stack of memory cards. Each card has a `pin` or `note` kind, who set it, when, and the body. Pins are auto-injected each turn; notes are scratchpad.

**Context tab:** stacked horizontal bar showing the context-window breakdown (System / Tools / Files / History / Memory / Free) with a legend, followed by a file list with token counts and pin indicators.

**Config tab:** system prompt (collapsible), model + sampling, limits (budget/tokens/wall-clock), on-error policy.

**Empty state:** "No agent selected" + hint about `⌘1`–`⌘9` jump shortcuts.

---

## Interactions

| Action | Trigger |
|---|---|
| Send to Director | `↵` in composer |
| Newline | `⇧↵` |
| Command bar | `⌘K` |
| New agent | `⌘N` |
| Interrupt current agent | `⌘.` |
| Jump to agent 1–9 | `⌘1` – `⌘9` |
| Resize Director column | drag the handle between Director and Agents |
| Resize Drawer | drag the handle between Agents and Drawer |
| Expand/collapse agent log | click the chevron, or click anywhere on the row to select |
| Select agent (opens drawer) | click the row body |
| Pause/resume agent | click pause icon, or `⌘.` while selected |
| Approve / fork / redirect | drawer action buttons |
| Filter agents | click filter chip (`all` / `running` / `waiting` / `done`) |

**Resize-handle micro-interaction:** transparent 5px-wide hit area with a 1px line at center. On hover or active-drag the line thickens to 2px and turns accent-green with a soft glow. Body cursor flips to `col-resize` for the duration of the drag.

**Pulsing dot:** `.dotled.running` and `.dotled.approval` render a ring that scales 1→1.5 and fades to 0 on a 1.6s ease-in-out loop. Static dots otherwise.

**Streaming cursor:** 7px-wide block that blinks 1.1s steps(2) on the last live message and at the end of the most recent log line.

---

## State the UI needs

The reference renders from these globals (see `data.jsx`):

```ts
interface Session {
  id: string;
  title: string;
  startedAt: string;          // 'HH:MM:SS'
  elapsed: string;            // 'MM:SS'
  totalTokens: number;
  totalCost: number;          // dollars
  budget: number;
  director: {
    model: string;
    tools: number;
    contextUsed: number;
    contextCap: number;
  };
}

interface DirectorMessage {
  who: 'user' | 'director' | 'system';
  name: string;
  time: string;
  body: string;
  plan?: PlanRow[];           // optional embedded plan tree
  live?: boolean;             // streaming
}

interface PlanRow {
  i: number;                  // 1-indexed
  role: AgentRole;
  name: string;               // agent id
  task: string;
}

type AgentRole = 'pm' | 'researcher' | 'coder' | 'qa' | 'devops';
type AgentStatus = 'running' | 'waiting' | 'approval' | 'paused' | 'done' | 'error';

interface Agent {
  id: string;
  role: AgentRole;
  roleLabel: string;          // 'Project Manager'
  name: string;
  status: AgentStatus;
  statusLabel: string;        // 'Running', 'Awaiting handoff', 'Approval needed'
  step: string;               // '2/4'
  task: string;
  tokens: number;
  cost: number;
  elapsed: string;
  model: string;
  log: LogLine[];
}

interface LogLine {
  ts: string;                 // 'HH:MM:SS.mmm'
  kind: 'thought' | 'tool' | 'result' | 'warn' | 'error' | 'note' | 'handoff';
  msg: string | {
    fn: string;
    args: { k: string; v: string }[];   // structured tool call
  };
  live?: boolean;
}

interface Tool { name: string; ns: string; count: number; last: string; }
interface MemoryCard { kind: 'pin' | 'note'; who: string; at: string; body: string; }
interface ContextFile { path: string; tk: number; pinned: boolean; }
interface CtxSeg { label: string; pct: number; color: string; }
```

In the live app: subscribe to a single orchestrator stream (Server-Sent Events or websocket) that emits log lines and agent state updates. Reducer pattern works well — each event is an action, the store is `{ session, agents: Agent[] }`.

---

## Design tokens

All defined as CSS variables in `styles.css`. Lift them into your design system.

### Surfaces (dark mode only)

```
--ink     #08090b    // outer window frame
--bg      #0b0d10    // pane bg
--panel   #111317    // pane head, top bar, status bar
--sub     #16181c    // chips, cards, sub-panels
--sub-2   #1a1d22    // pressed/selected sub
--border  #1f2229    // 1px hairlines
--border-2 #262932   // emphasized borders
```

### Text

```
--text    #e6e6ea    // primary
--text-2  #c5c7cd    // secondary
--muted   #6b7080    // labels, timestamps
--muted-2 #4a4e58    // tree connectors, scale ticks
```

### Accent (tweakable — terminal green by default)

```
--accent       #4ade80
--accent-dim   rgba(74,222,128,0.18)
--accent-line  rgba(74,222,128,0.42)
```

### Status colors

| State | Hex | Use |
|---|---|---|
| running    | `#4ade80` | pulsing dot, "running" pill |
| waiting    | `#f5b544` | amber dot |
| approval   | `#4cc9f0` | cyan dot (pulse) |
| paused     | `#4cc9f0` | cyan dot (static) |
| done       | `#6b7080` | gray dot |
| error      | `#ef5b5b` | red dot |

### Role tints (used for the role label on each agent + sigil color in drawer)

```
pm          #4ade80
researcher  #60a5fa
coder       #c084fc
qa          #fbbf24
devops      #f97316
```

### Log-line kind colors

```
thought  #9aa0aa
tool     #60a5fa
result   #4ade80
warn     #f5b544
error    #ef5b5b
note     #c084fc
handoff  #f97316
```

### Typography

- **Family**: `JetBrains Mono`, fallback `Berkeley Mono`, `IBM Plex Mono`, `ui-monospace`, `SFMono-Regular`, `Menlo`, monospace
- **Sizes**: 9 · 10 · 11 · 12 · 13 · 14 px
- **Weights**: 400 (body), 500 (titles), 600 (strong), 700 (badges)
- **Numbers**: `font-variant-numeric: tabular-nums` globally — every count column lines up
- **Labels**: 10px UPPERCASE, `letter-spacing: 0.06em` for section labels and KPI labels; 0.08em for pane titles ("DIRECTOR", "AGENTS · 6 ACTIVE")

### Radii

- 3px — code/inline chips
- 4–5px — chips, tool rows, log cards
- 6px — buttons, pills, panel cards
- 7px — inputs
- 12px — empty-state glyph

### Shadows

Used sparingly — this is a flat terminal. Only the active resize handle gets a `0 0 8px var(--accent-line)` glow. KPI tiles are border-only.

### Spacing

8px base unit. Common: 4 · 6 · 8 · 10 · 12 · 14 · 18 · 24 · 32 px.

---

## Files in this handoff

```
design_handoff_orchestrator/
├── README.md                         ← you are here
├── design-reference/
│   ├── Orchestrator.html             ← open this to see the empty-state design
│   ├── styles.css                    ← all visual tokens + component CSS
│   ├── data.jsx                      ← documented data shapes + empty defaults
│   ├── icons.jsx                     ← inline SVG icon set
│   ├── shell.jsx                     ← TopBar / LeftRail / StatusBar
│   ├── director.jsx                  ← Director chat pane + composer + empty state
│   ├── agents.jsx                    ← Agents workspace + log streams + empty state
│   ├── drawer.jsx                    ← Right detail drawer + tabs + empty state
│   ├── app.jsx                       ← Top-level composition + resize handles
│   └── tweaks-panel.jsx              ← Tweak UI primitives (not needed in prod)
└── screenshots/
    ├── empty-state.png               ← all panes empty (default open)
    ├── populated-overview.png        ← what it looks like mid-session
    └── populated-drawer-detail.png   ← drawer with all tabs/kpis
```

Open `design-reference/Orchestrator.html` in a browser to interact with the empty-state design.

---

## Notes for the implementer

- **Mono everywhere.** Resist the urge to switch chat body to a humanist sans. The whole point is that humans, the Director, and the agents read in the same terminal voice.
- **Tabular numbers always.** Token counts, costs, elapsed times all need to align in columns.
- **No emoji.** Use the inline SVG icons in `icons.jsx` (or your own set) — don't reach for Unicode.
- **No gradient backgrounds.** The single gradient is the Director avatar — leave the rest flat.
- **Status pulse is critical.** A still UI looks dead. Running agents *must* show the 1.6s pulse.
- **Drawer is single-instance.** Only one agent is "selected" at a time; switching agents replaces the drawer contents — no stacking.
- **Resize state is per-user.** Persist `dirW` and `drawerW` in localStorage (or settings store) so the layout survives reloads.
- **Empty states matter.** Most ops in a real session take 10+ minutes — at any given moment a column may have nothing to show. Each empty state is part of the design, not an afterthought.
- **Window chrome.** The traffic lights in `shell.jsx` are decorative for the HTML reference. In Tauri/Electron use the native window controls and remove these.
- **Tweaks panel** is a design-time aid (live accent color, layout reset). It's not shipping UI — strip it from the production build.

---

## Out of scope for this handoff

These exist in the rail nav but aren't designed yet. Pick them up as separate work:

- **Templates** screen — picker + editor for saved agent fleets
- **Tools** screen — registry of available tools, per-role allow-lists
- **Spend** screen — historical cost analytics, per-session, per-agent, per-tool
- **Runs** screen — past sessions, searchable
- **Settings** — API keys, model preferences, theme

The agent-creation flow (`⌘N`) needs a modal — not designed. Treat it as a stepper: pick role → pick template → seed task → confirm.
