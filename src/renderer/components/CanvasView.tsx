import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useInternalNode,
  getBezierPath,
  BaseEdge,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
  type InternalNode,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Agent, EffortLevel, Provider } from '../../shared/types';
import { Icon } from './Icon';
import { SpawnAgentForm } from './SpawnAgentForm';
import { FocusedFixDialog } from './FocusedFixDialog';
import { OnboardingBanner } from './OnboardingBanner';

/**
 * Flightdeck canvas — the sole home view. Mirrors the live agent fleet as a
 * node-graph: a dark Director anchor node on the left (hosting the live chat)
 * fanning curved bezier lanes out to one node per agent. Agents are placed by
 * a bespoke vertical-stagger layout (see layoutStagger / buildChainModel) — a
 * column in plan order with a rightward stagger by handoff depth — so the fleet
 * reads as the mockup's 2D composition, NOT a single left-to-right row.
 *
 * Re-layout runs ONLY when the topology (the set of agent ids) changes — see
 * the signature check in the effect below. Status/step/elapsed ticks update
 * node data in place without moving anything, which is the anti-thrash rule.
 */

const NODE_W = 234;
const NODE_H = 134;
const DIRECTOR_ID = '__director__';

// The Director is a first-class anchor node that hosts the live chat/plan/
// composer (Phase 5c "faithful" — the mockup draws it ON the canvas, wired to
// the agents it spawns). It's a fixed-size, non-draggable box; its content is
// fed in from App via context (see DirectorSlotContext) so message/stream
// ticks reconcile the real DirectorPane in place — scroll, focus, and
// streaming survive — without churning React Flow's node data.
export const DIRECTOR_NODE_W = 480;
const DIRECTOR_NODE_H = 564;

// Stagger-layout tunables (bespoke coordinate layout — see layoutStagger).
const GAP_Y = 40; // vertical air between stacked agents
const ROW_H = NODE_H + GAP_Y; // one vertical slot
const COL_STEP = 150; // horizontal stagger per depth unit
const CLUSTER_LEFT = DIRECTOR_NODE_W + 150; // x of the depth-0 column (mockup ~524)
const DEPTH_CAP = 3; // cap rightward stagger so deep chains stay a column, not a diagonal
const CHAIN_FLAT = 2; // first N chain steps share a column (pm + researcher in the mockup)
const PAD = 40; // normalization padding so nothing is ever negative

/** Live Director UI piped from App into the `director` node. */
const DirectorSlotContext = createContext<ReactNode>(null);

/**
 * Node-level actions piped to the agent nodes the same way the Director slot
 * is — a context Provider wrapping <ReactFlow> reaches the custom node
 * components. Today just "close" (abort-if-running + remove).
 */
const CanvasNodeActionsContext = createContext<{
  onClose: (id: string) => void;
}>({ onClose: () => undefined });

// Map an agent status onto the mockup's four status families (run / wait /
// done / appr) + error. Drives the strip, dot, and status-pill colours via
// the .cv-node.s-* CSS classes (see index.css). Deliberately non-green per
// the redesign: done is a quiet slate, not a celebratory green.
function statusClass(status: string): string {
  if (status === 'running') return 's-run';
  if (status === 'waiting') return 's-wait';
  if (status === 'approval') return 's-appr';
  if (status === 'error') return 's-err';
  return 's-done'; // done / aborted / paused — settled slate
}

function agentData(a: Agent): Record<string, unknown> {
  return {
    name: a.name,
    role: a.role,
    roleLabel: a.roleLabel,
    status: a.status,
    statusLabel: a.statusLabel,
    step: a.step,
    task: a.task,
    elapsed: a.elapsed,
    subtype: a.subtype ?? '',
  };
}

function AgentNodeView({ id, data, selected }: NodeProps) {
  const status = String(data.status);
  const running = status === 'running';
  const role = String(data.role);
  const subtype = String(data.subtype ?? '');
  const task = String(data.task ?? '');
  const actions = useContext(CanvasNodeActionsContext);
  return (
    <div
      className={`cv-node ${statusClass(status)}${selected ? ' sel' : ''}`}
      style={{ width: NODE_W }}
    >
      {/* Hover-reveal close pill. `nodrag` + stopPropagation keep the click
          from dragging or selecting the node. Removes the agent (aborting it
          first if it's still running). */}
      <button
        type="button"
        className="cv-close nodrag"
        title="Close agent — aborts it if still running, then removes it"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          actions.onClose(id);
        }}
      >
        <Icon name="x" size={10} />
      </button>
      {/* A source + target handle on every side, all hidden. buildEdges picks
          the handle on whichever side FACES the connected node, so an edge
          enters/exits the natural side (left/right/top/bottom) instead of
          always the same one — and never loops backward across a box. Each is
          id'd; every edge names the exact handle it uses. */}
      <Handle id="tl" type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle id="tt" type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle id="tr" type="target" position={Position.Right} style={{ opacity: 0 }} />
      <Handle id="tb" type="target" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle id="sl" type="source" position={Position.Left} style={{ opacity: 0 }} />
      <Handle id="st" type="source" position={Position.Top} style={{ opacity: 0 }} />
      <Handle id="sr" type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Handle id="sb" type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <span className="cv-strip" />
      <div className="cv-head">
        <span className={'cv-dot' + (running ? ' run' : '')} />
        <div className="cv-id">
          <span className="cv-nm">{String(data.name)}</span>
          <span className="cv-rolechip">
            {role}
            {subtype ? ` · ${subtype}` : ''}
          </span>
        </div>
        <span className="cv-stag">{String(data.statusLabel)}</span>
      </div>
      <div className="cv-task">{task}</div>
      <div className="cv-meta">
        <div className="cv-cell">
          <span className="cl">step</span>
          <span className="cvv">{String(data.step)}</span>
        </div>
        <div className="cv-cell">
          <span className="cl">elapsed</span>
          <span className="cvv">{String(data.elapsed)}</span>
        </div>
      </div>
    </div>
  );
}

function DirectorNodeView() {
  // `nodrag` so interacting with the chat/composer never starts a node drag;
  // `nowheel` so scrolling the chat doesn't zoom the canvas. The live pane is
  // pulled from context — see DirectorSlotContext.
  const slot = useContext(DirectorSlotContext);
  return (
    <div
      className="nodrag nowheel director-anchor"
      style={{
        width: DIRECTOR_NODE_W,
        height: DIRECTOR_NODE_H,
        boxSizing: 'border-box',
        display: 'flex',
        borderRadius: 14,
        border: '1px solid var(--accent-line)',
        boxShadow:
          '0 0 0 1px rgba(111,155,255,0.18), 0 22px 48px -22px rgba(8,14,28,0.65)',
        overflow: 'hidden',
        background: 'var(--panel)',
      }}
    >
      {slot}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { agent: AgentNodeView, director: DirectorNodeView };

// A node centre in cluster-local coords (pre-normalization; only relative
// deltas matter). Used to pick which side an edge should leave/enter.
type Pt = { x: number; y: number };

/** Which side of `from` faces `to` → a handle suffix (l/r/t/b). */
function sideToward(from: Pt, to: Pt): 'l' | 'r' | 't' | 'b' {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'r' : 'l';
  return dy >= 0 ? 'b' : 't';
}

// ── Floating edge ──────────────────────────────────────────────
// Renders the bezier from the boundary point of each node that FACES the other
// node, recomputed from LIVE node positions — so edges follow a node when it's
// dragged and always leave/enter the natural side. The edge still carries valid
// sourceHandle/targetHandle (see buildEdges) so React Flow can resolve handle
// positions and doesn't drop it; this component overrides the geometry.
function nodeIntersection(node: InternalNode, other: InternalNode): Pt {
  const w = (node.measured.width ?? NODE_W) / 2;
  const h = (node.measured.height ?? NODE_H) / 2;
  const cx = node.internals.positionAbsolute.x + w;
  const cy = node.internals.positionAbsolute.y + h;
  const ox =
    other.internals.positionAbsolute.x + (other.measured.width ?? NODE_W) / 2;
  const oy =
    other.internals.positionAbsolute.y + (other.measured.height ?? NODE_H) / 2;
  const xx = (ox - cx) / (2 * w) - (oy - cy) / (2 * h);
  const yy = (ox - cx) / (2 * w) + (oy - cy) / (2 * h);
  const a = 1 / (Math.abs(xx) + Math.abs(yy) || 1);
  const dx = a * xx;
  const dy = a * yy;
  return { x: w * (dx + dy) + cx, y: h * (-dx + dy) + cy };
}

function boundarySide(node: InternalNode, point: Pt): Position {
  const nx = Math.round(node.internals.positionAbsolute.x);
  const ny = Math.round(node.internals.positionAbsolute.y);
  const nw = node.measured.width ?? NODE_W;
  const px = Math.round(point.x);
  const py = Math.round(point.y);
  if (px <= nx + 1) return Position.Left;
  if (px >= nx + nw - 1) return Position.Right;
  if (py <= ny + 1) return Position.Top;
  return Position.Bottom;
}

function FloatingEdge({ id, source, target, markerEnd, style }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;
  const sp = nodeIntersection(sourceNode, targetNode);
  const tp = nodeIntersection(targetNode, sourceNode);
  const [path] = getBezierPath({
    sourceX: sp.x,
    sourceY: sp.y,
    sourcePosition: boundarySide(sourceNode, sp),
    targetX: tp.x,
    targetY: tp.y,
    targetPosition: boundarySide(targetNode, tp),
  });
  // The edge's className (e.g. cv-flow) is applied by React Flow to the wrapper
  // <g>, so the marching-ants selector still reaches BaseEdge's path.
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />;
}

const edgeTypes = { floating: FloatingEdge };

interface ChainModel {
  ordered: Agent[];
  rowIndex: Map<string, number>;
  chainPos: Map<string, number>;
  prevOf: Map<string, string>;
  parentOf: Map<string, string | null>;
  depthOf: Map<string, number>;
}

/**
 * Single source of truth for the orchestration topology, consumed by BOTH the
 * layout and the edge builder so they can never drift. The y axis comes from
 * plan order (every agent by startedAt, id tiebreak); the x axis comes from
 * handoff/fork DEPTH (the mockup's staircase is depth, not branching).
 */
function buildChainModel(agents: Agent[]): ChainModel {
  const ids = new Set(agents.map((a) => a.id));
  // Break startedAt ties by the agents-array order (the fleet arrives in spawn
  // order), NOT by id — so near-simultaneous spawns still stack in plan order
  // instead of scrambling by uuid.
  const order = new Map(agents.map((a, i) => [a.id, i] as const));
  const byStart = (a: Agent, b: Agent) =>
    a.startedAt - b.startedAt ||
    (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);

  // The Director's sequential (non-fork) chain defines handoff + plan order.
  const chain = agents
    .filter((a) => a.spawnedBy === 'director' && !a.forkedFromId)
    .slice()
    .sort(byStart);
  const chainPos = new Map<string, number>();
  chain.forEach((a, i) => chainPos.set(a.id, i));
  const prevOf = new Map<string, string>();
  for (let i = 1; i < chain.length; i++) prevOf.set(chain[i].id, chain[i - 1].id);

  // layout parent: fork parent > chain predecessor > null (a root).
  const byId = new Map(agents.map((a) => [a.id, a] as const));
  const parentOf = new Map<string, string | null>();
  for (const a of agents) {
    if (a.forkedFromId && ids.has(a.forkedFromId)) parentOf.set(a.id, a.forkedFromId);
    else if (prevOf.has(a.id)) parentOf.set(a.id, prevOf.get(a.id) ?? null);
    else parentOf.set(a.id, null);
  }

  // y axis: PLAN/handoff order, NOT raw timestamp — so a tidy top-to-bottom
  // staircase survives clock ties (sequential spawns can share a coarse
  // startedAt). Chain members rank by chain position; forks sit just below
  // their parent; standalone agents fall after the chain. Ties break by
  // startedAt then id.
  const laneMemo = new Map<string, number>();
  const laneRank = (id: string, guard: Set<string>): number => {
    const cached = laneMemo.get(id);
    if (cached !== undefined) return cached;
    const cp = chainPos.get(id);
    let r: number;
    if (cp !== undefined) {
      r = cp;
    } else if (guard.has(id)) {
      r = chain.length; // cycle guard
    } else {
      guard.add(id);
      const parent = parentOf.get(id) ?? null;
      r = parent != null ? laneRank(parent, guard) + 0.5 : chain.length;
    }
    laneMemo.set(id, r);
    return r;
  };
  const ordered = agents.slice().sort((a, b) => {
    const ra = laneRank(a.id, new Set());
    const rb = laneRank(b.id, new Set());
    return ra - rb || byStart(a, b);
  });
  const rowIndex = new Map<string, number>();
  ordered.forEach((a, i) => rowIndex.set(a.id, i));

  // x axis: ONE depth definition. Chain hops use the CHAIN_FLAT clamp (the
  // first couple of steps share a column, as in the mockup); fork hops always
  // step right off their parent. Memoized + cycle-guarded + capped.
  const memo = new Map<string, number>();
  const rawDepth = (id: string, guard: Set<string>): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (guard.has(id)) return 0; // cycle guard
    guard.add(id);
    const a = byId.get(id);
    const parent = parentOf.get(id) ?? null;
    let d: number;
    if (!a || parent == null) {
      d = 0; // root: chain head or standalone user-spawned agent
    } else if (a.forkedFromId && ids.has(a.forkedFromId)) {
      d = rawDepth(parent, guard) + 1; // fork hop: always step right
    } else {
      const cp = chainPos.get(id) ?? 0; // chain hop: derive from chain position
      d = Math.max(0, cp - (CHAIN_FLAT - 1));
    }
    memo.set(id, d);
    return d;
  };
  const depthOf = new Map<string, number>();
  for (const a of agents) {
    depthOf.set(a.id, Math.min(rawDepth(a.id, new Set()), DEPTH_CAP));
  }

  return { ordered, rowIndex, chainPos, prevOf, parentOf, depthOf };
}

/**
 * Bespoke vertical-stagger layout (replaces dagre — see the layout-design
 * workflow synthesis). Agents form a vertical column in plan order (row → y)
 * with a rightward stagger by handoff/fork depth (depth → x); the Director is
 * pinned to the left and vertically centered on the cluster. This is what stops
 * the fleet rendering as a single left-to-right row. React Flow positions are
 * top-left, so we author top-left directly — no centering math per node.
 */
function layoutStagger(agents: Agent[], cm: ChainModel): Node[] {
  const agentNodes: Node[] = agents.map((a) => {
    const i = cm.rowIndex.get(a.id) ?? 0;
    const d = cm.depthOf.get(a.id) ?? 0;
    return {
      id: a.id,
      type: 'agent',
      position: { x: CLUSTER_LEFT + d * COL_STEP, y: i * ROW_H },
      data: agentData(a),
      selected: false, // reconciled by the selectedId effect
    };
  });

  const n = agents.length;
  const clusterHeight = n > 0 ? (n - 1) * ROW_H + NODE_H : NODE_H;
  const directorNode: Node = {
    id: DIRECTOR_ID,
    type: 'director',
    position: { x: 0, y: clusterHeight / 2 - DIRECTOR_NODE_H / 2 },
    data: {},
    draggable: false,
    selectable: false,
  };

  // Normalize so nothing is negative (stable fitView), computed over all nodes.
  const all = [directorNode, ...agentNodes];
  const minX = Math.min(...all.map((no) => no.position.x));
  const minY = Math.min(...all.map((no) => no.position.y));
  const dx = PAD - minX;
  const dy = PAD - minY;
  return all.map((no) => ({
    ...no,
    position: { x: no.position.x + dx, y: no.position.y + dy },
  }));
}

const REDUCE_MOTION =
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Edge + grid colours per theme. The canvas sets these in JS (edge strokes,
// SVG-marker arrowheads, grid pattern fill), so unlike the chrome they can't
// ride CSS vars — we key concrete values on the resolved theme and rebuild
// the edges on a theme flip. Values mirror the --cv-edge-*/--cv-grid-* tokens.
interface EdgePalette {
  acc: string; // handoff stroke + active arrowheads
  accSoft: string; // active Director plan-lane stroke (--acc-edge)
  accArrow: string; // active plan-lane arrowhead
  dim: string; // settled slate stroke
  dimArrow: string; // settled arrowhead
  fork: string; // fork slate
}
const EDGE_PALETTE: Record<'light' | 'dark', EdgePalette> = {
  light: {
    acc: '#1d4ed8',
    accSoft: 'rgba(29,78,216,0.55)',
    accArrow: 'rgba(29,78,216,0.7)',
    dim: 'rgba(58,68,92,0.34)',
    dimArrow: 'rgba(58,68,92,0.5)',
    fork: '#94a3b8',
  },
  dark: {
    acc: '#6f9bff',
    accSoft: 'rgba(111,155,255,0.60)',
    accArrow: 'rgba(111,155,255,0.7)',
    dim: 'rgba(150,165,195,0.30)',
    dimArrow: 'rgba(150,165,195,0.5)',
    fork: '#5b657a',
  },
};
const GRID_PALETTE: Record<'light' | 'dark', { line: string; dot: string }> = {
  light: { line: 'rgba(29,49,90,0.045)', dot: 'rgba(29,49,90,0.10)' },
  dark: { line: 'rgba(150,170,210,0.06)', dot: 'rgba(150,170,210,0.14)' },
};

/**
 * Build the edge set that draws the orchestration flow as smooth cubic beziers
 * (the default edge type — matches the mockup's hand-drawn lanes). Three
 * families, exactly one incoming edge per agent, derived from the shared
 * ChainModel so geometry and edges can never drift:
 *  - fork ancestry: parent -> fork (dashed slate);
 *  - handoff: previous chain agent -> this (solid accent; marching-ants when live);
 *  - Director plan-lane: Director -> chain head / standalone (soft accent;
 *    quieter solid slate once settled).
 * Each edge attaches to the handle on whichever SIDE faces its neighbour (see
 * sideToward) — so it leaves/enters the natural side and never loops backward
 * across a box. Solid strokes (full lines read better than dashes); only the
 * fork keeps a dash, to mark it as ancestry rather than flow.
 */
function buildEdges(agents: Agent[], cm: ChainModel, p: EdgePalette): Edge[] {
  const ids = new Set(agents.map((a) => a.id));
  const arrow = (color: string) => ({
    type: MarkerType.ArrowClosed,
    width: 15,
    height: 15,
    color,
  });

  // Cluster-local node centres (relative deltas only — normalization is a
  // uniform shift, so it can't change which side faces which).
  const n = agents.length;
  const clusterHeight = n > 0 ? (n - 1) * ROW_H + NODE_H : NODE_H;
  const centerOf = (id: string): Pt => {
    if (id === DIRECTOR_ID) return { x: DIRECTOR_NODE_W / 2, y: clusterHeight / 2 };
    const i = cm.rowIndex.get(id) ?? 0;
    const d = cm.depthOf.get(id) ?? 0;
    return { x: CLUSTER_LEFT + d * COL_STEP + NODE_W / 2, y: i * ROW_H + NODE_H / 2 };
  };
  // Pick the facing-side handle for each end. The Director has a single
  // (unnamed) source handle; agents have id'd handles on every side.
  const handles = (sourceId: string, targetId: string) => {
    const sc = centerOf(sourceId);
    const tc = centerOf(targetId);
    return {
      sourceHandle: sourceId === DIRECTOR_ID ? undefined : 's' + sideToward(sc, tc),
      targetHandle: 't' + sideToward(tc, sc),
    };
  };

  return agents.map((a): Edge => {
    // `live` agents get the marching-ants flow via the `cv-flow` class — NOT
    // React Flow's `animated` flag, which hard-sets its own cadence. `live` is
    // reduced-motion gated, so no edge gets `cv-flow` under reduced motion.
    const live = !REDUCE_MOTION && a.status === 'running';
    const settled =
      a.status === 'done' || a.status === 'aborted' || a.status === 'paused';
    // (1) fork ancestry: parent -> fork, dashed slate, never animated.
    if (a.forkedFromId && ids.has(a.forkedFromId)) {
      return {
        id: `fork-${a.id}`,
        source: a.forkedFromId,
        target: a.id,
        ...handles(a.forkedFromId, a.id),
        type: 'floating',
        label: 'fork',
        animated: false,
        markerEnd: arrow(p.fork),
        style: { stroke: p.fork, strokeWidth: 1.5, strokeDasharray: '5 4' },
        labelStyle: { fill: 'var(--muted)', fontSize: 10, fontFamily: 'system-ui, sans-serif' },
        labelBgStyle: { fill: 'var(--cv-canvas-bg)', fillOpacity: 0.9 },
      };
    }
    // (2) handoff: previous chain agent -> this. Live = accent marching-ants;
    //     idle = solid accent; settled = quieter solid slate (still a full line).
    const prev = cm.prevOf.get(a.id);
    if (prev) {
      return {
        id: `ho-${a.id}`,
        source: prev,
        target: a.id,
        ...handles(prev, a.id),
        type: 'floating',
        ...(live ? { className: 'cv-flow' } : {}),
        markerEnd: arrow(settled ? p.dimArrow : p.acc),
        style: { stroke: settled ? p.dim : p.acc, strokeWidth: settled ? 1.4 : 1.6 },
      };
    }
    // (3) Director plan-lane: Director -> chain head / standalone. Live = soft
    //     accent marching-ants; active = soft accent (--acc-edge); settled =
    //     quieter solid slate.
    return {
      id: `e-${a.id}`,
      source: DIRECTOR_ID,
      target: a.id,
      ...handles(DIRECTOR_ID, a.id),
      type: 'floating',
      ...(live ? { className: 'cv-flow' } : {}),
      markerEnd: arrow(settled ? p.dimArrow : live ? p.acc : p.accArrow),
      style: { stroke: settled ? p.dim : p.accSoft, strokeWidth: settled ? 1.4 : 1.6 },
    };
  });
}

interface Props {
  agents: Agent[];
  selectedId: string | null;
  onSelectAgent: (id: string | null) => void;
  /** Resolved UI theme ('light' | 'dark') — drives the canvas's JS colours
   *  (edge strokes, arrowheads, grid) that can't ride CSS vars. */
  theme: 'light' | 'dark';
  /**
   * The live Director UI (chat + plans + composer). Rendered inside the
   * Director anchor node so it sits ON the canvas, wired by edges to the
   * agents it spawns. Piped through context so streaming/scroll/focus survive
   * data ticks (see DirectorSlotContext).
   */
  director: ReactNode;
  // Spawn surface re-homed from AgentsPane so the canvas reaches parity
  // before the panes are deleted.
  projectId: string;
  workspace: string;
  defaultModel: string;
  defaultEffort: EffortLevel;
  provider: Provider;
  spawning: boolean;
  setSpawning: (next: boolean) => void;
  onboardingBanner?: {
    busy: boolean;
    onRun: () => void;
    onSkip: () => void;
  };
}

export function CanvasView({
  agents,
  selectedId,
  onSelectAgent,
  theme,
  director,
  projectId,
  workspace,
  defaultModel,
  defaultEffort,
  provider,
  spawning,
  setSpawning,
  onboardingBanner,
}: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const sigRef = useRef<string>('');
  const rfRef = useRef<ReactFlowInstance | null>(null);
  const didFitRef = useRef(false);
  const [focusedFixOpen, setFocusedFixOpen] = useState(false);
  const activeCount = agents.filter(
    (a) => a.status === 'running' || a.status === 'waiting',
  ).length;
  // Concrete per-theme colours for the bits drawn in JS (edges + grid). Stable
  // per theme (module consts), so they only change deps when the theme flips.
  const ep = EDGE_PALETTE[theme];
  const grid = GRID_PALETTE[theme];

  // Rebuild + re-layout only when the topology changes; otherwise patch data
  // in place so a status tick never triggers a relayout.
  useEffect(() => {
    const sig = agents.map((a) => a.id).slice().sort().join('|');
    if (sig !== sigRef.current) {
      sigRef.current = sig;
      const cm = buildChainModel(agents);
      const newEdges = buildEdges(agents, cm, ep);
      setNodes(layoutStagger(agents, cm));
      setEdges(newEdges);
      // Frame the fleet ONCE, the first time nodes appear (the `fitView` prop
      // fits on mount — before this async layout exists — so the tall Director
      // node + a long handoff chain would otherwise run off-screen). We don't
      // refit on every spawn: that would yank the viewport out from under
      // someone reading the chat as a plan spawns its agents. The Controls'
      // fit button reframes on demand. Double rAF so the freshly-added nodes
      // are measured first — a single frame can fit a still-unmeasured
      // rightmost node off-screen.
      if (!didFitRef.current && agents.length > 0) {
        didFitRef.current = true;
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            rfRef.current?.fitView({ padding: 0.2, maxZoom: 0.85, duration: 350 }),
          ),
        );
      }
    } else {
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id === DIRECTOR_ID) return n;
          const a = agents.find((x) => x.id === n.id);
          return a ? { ...n, data: agentData(a) } : n;
        }),
      );
      // Edges are cheap to rebuild and depend only on immutable fields + status;
      // rebuilding picks up status -> animated changes without a relayout.
      setEdges(buildEdges(agents, buildChainModel(agents), ep));
    }
    // `ep` in deps: a theme flip rebuilds the edges with the new palette (the
    // else-branch path, since the agent id-set is unchanged). Nodes + grid +
    // wrapper re-theme via CSS vars / re-render, so they need no rebuild.
  }, [agents, selectedId, setNodes, setEdges, ep]);

  // Reflect externally-driven selection (e.g. ⌘1-9 jumps) onto the nodes.
  useEffect(() => {
    setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === selectedId })));
  }, [selectedId, setNodes]);

  // Close (remove) an agent node. `registry.remove` already aborts a running
  // agent before dropping it, so this is safe for any status — but it's a
  // permanent delete (the row + its pinned notes go too), so confirm before
  // killing in-flight work. The removal broadcasts back through
  // onAgentRemove, which prunes it from the agents list and re-renders.
  const handleCloseAgent = useCallback(
    (id: string) => {
      const a = agents.find((x) => x.id === id);
      if (!a) return;
      const active = a.status === 'running' || a.status === 'waiting';
      if (
        active &&
        !window.confirm(`"${a.name}" is still running. Abort and remove it?`)
      ) {
        return;
      }
      if (selectedId === id) onSelectAgent(null);
      void window.api.removeAgent(id);
    },
    [agents, selectedId, onSelectAgent],
  );
  const nodeActions = useMemo(
    () => ({ onClose: handleCloseAgent }),
    [handleCloseAgent],
  );

  return (
    <CanvasNodeActionsContext.Provider value={nodeActions}>
    <DirectorSlotContext.Provider value={director}>
    <div
      style={{
        flex: 1,
        minWidth: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--cv-canvas-bg)',
      }}
    >
      <div className="pane-head" style={{ flexShrink: 0 }}>
        <span className="title">
          Agents{' '}
          <b>
            · {activeCount} active
            {agents.length > activeCount ? ` / ${agents.length} total` : ''}
          </b>
        </span>
        <span className="spacer" />
        <button
          className="tb-btn"
          onClick={() => setFocusedFixOpen(true)}
          title="Skip the Director — spawn a single coder pinned to one file"
        >
          <Icon name="file" size={11} /> Focused fix
        </button>
        <button className="tb-btn primary" onClick={() => setSpawning(true)}>
          <Icon name="plus" size={11} /> New agent
          <span className="kbd">⌘N</span>
        </button>
      </div>

      {onboardingBanner && (
        <OnboardingBanner
          busy={onboardingBanner.busy}
          onRun={onboardingBanner.onRun}
          onSkip={onboardingBanner.onSkip}
        />
      )}

      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onInit={(inst) => {
            rfRef.current = inst;
          }}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, node) => {
            // Clicking inside the Director node = interacting with its chat;
            // don't disturb the agent selection driving the inspector.
            if (node.id !== DIRECTOR_ID) onSelectAgent(node.id);
          }}
          onPaneClick={() => onSelectAgent(null)}
          nodesConnectable={false}
          fitView
          minZoom={0.3}
          maxZoom={1.75}
        >
          {/* Blueprint graph-paper grid (bold-flightdeck.html .canvas). Two
              layered <Background> svgs — each needs a UNIQUE id or their
              <pattern> ids collide (pattern-${rfId}${id}) and only one draws.
              Layered (not a static CSS gradient) so the grid pans + zooms with
              the viewport like real graph paper. Order: faint cell lines under,
              denser dots over. base #eceef3 comes from the wrapper div behind;
              we leave bgColor unset so both svgs stay transparent and stack. */}
          <Background
            id="grid-lines"
            variant={BackgroundVariant.Lines}
            gap={26}
            lineWidth={1}
            color={grid.line}
          />
          <Background
            id="grid-dots"
            variant={BackgroundVariant.Dots}
            gap={26}
            size={1}
            color={grid.dot}
          />
          <Controls showInteractive={false} />
        </ReactFlow>
        {agents.length === 0 && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '52%',
              transform: 'translate(-50%, -50%)',
              color: 'var(--cv-empty-ink)',
              font: '13px system-ui, sans-serif',
              pointerEvents: 'none',
              textAlign: 'center',
            }}
          >
            No agents yet. Use New agent, or send the Director a task.
          </div>
        )}
      </div>

      {spawning && (
        <SpawnAgentForm
          projectId={projectId}
          defaultWorkspace={workspace}
          defaultModel={defaultModel}
          defaultEffort={defaultEffort}
          provider={provider}
          onCancel={() => setSpawning(false)}
          onSpawned={() => setSpawning(false)}
        />
      )}
      {focusedFixOpen && (
        <FocusedFixDialog
          projectId={projectId}
          workspace={workspace}
          defaultModel={defaultModel}
          defaultEffort={defaultEffort}
          provider={provider}
          onCancel={() => setFocusedFixOpen(false)}
          onSpawned={() => setFocusedFixOpen(false)}
        />
      )}
    </div>
    </DirectorSlotContext.Provider>
    </CanvasNodeActionsContext.Provider>
  );
}
