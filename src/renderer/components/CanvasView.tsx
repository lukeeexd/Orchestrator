import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
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
export const DIRECTOR_NODE_W = 384;
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

function AgentNodeView({ data, selected }: NodeProps) {
  const status = String(data.status);
  const running = status === 'running';
  const role = String(data.role);
  const subtype = String(data.subtype ?? '');
  const task = String(data.task ?? '');
  return (
    <div
      className={`cv-node ${statusClass(status)}${selected ? ' sel' : ''}`}
      style={{ width: NODE_W }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
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
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
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
      {/* Visible fan-origin dot: every plan lane launches from the Director's
          right edge, like the mockup's edge-dots (one handle = one dot). */}
      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 9,
          height: 9,
          background: '#6f9bff',
          border: '2px solid #161d29',
          opacity: 1,
        }}
      />
    </div>
  );
}

const nodeTypes = { agent: AgentNodeView, director: DirectorNodeView };

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
  const byStart = (a: Agent, b: Agent) =>
    a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1);

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

/**
 * Build the edge set that draws the orchestration flow as smooth cubic beziers
 * (type 'default' — matches the mockup's hand-drawn lanes, not stepped elbows).
 * Three families, exactly one incoming edge per agent, derived from the shared
 * ChainModel so geometry and edges can never drift:
 *  - fork ancestry: parent -> fork (dashed slate), from `forkedFromId`;
 *  - handoff: previous chain agent -> this (solid accent, animated when live);
 *  - Director plan-lane: Director -> chain head / standalone agent, dimmed +
 *    dashed once the lane has settled (done / aborted / paused).
 * Cheap to rebuild on every update. Handles stay Left-target / Right-source
 * (no Top/Bottom, no ids) so edges never silently vanish.
 */
function buildEdges(agents: Agent[], cm: ChainModel): Edge[] {
  const ids = new Set(agents.map((a) => a.id));
  const arrow = (color: string) => ({
    type: MarkerType.ArrowClosed,
    width: 15,
    height: 15,
    color,
  });

  return agents.map((a): Edge => {
    const live = !REDUCE_MOTION && a.status === 'running';
    const settled =
      a.status === 'done' || a.status === 'aborted' || a.status === 'paused';
    if (a.forkedFromId && ids.has(a.forkedFromId)) {
      return {
        id: `fork-${a.id}`,
        source: a.forkedFromId,
        target: a.id,
        type: 'default',
        label: 'fork',
        animated: false,
        markerEnd: arrow('#94a3b8'),
        style: { stroke: '#94a3b8', strokeWidth: 1.5, strokeDasharray: '5 4' },
        labelStyle: { fill: '#5b6473', fontSize: 10, fontFamily: 'system-ui, sans-serif' },
        labelBgStyle: { fill: '#eceef3', fillOpacity: 0.9 },
      };
    }
    const prev = cm.prevOf.get(a.id);
    if (prev) {
      return {
        id: `ho-${a.id}`,
        source: prev,
        target: a.id,
        type: 'default',
        animated: live,
        markerEnd: arrow('#1d4ed8'),
        style: { stroke: '#1d4ed8', strokeWidth: 1.75 },
      };
    }
    return {
      id: `e-${a.id}`,
      source: DIRECTOR_ID,
      target: a.id,
      type: 'default',
      animated: live,
      markerEnd: arrow(settled ? 'rgba(58,68,92,0.5)' : '#9aa3b2'),
      style: settled
        ? { stroke: 'rgba(58,68,92,0.34)', strokeWidth: 1.4, strokeDasharray: '4 5' }
        : { stroke: '#9aa3b2', strokeWidth: 1.5 },
    };
  });
}

interface Props {
  agents: Agent[];
  selectedId: string | null;
  onSelectAgent: (id: string | null) => void;
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

  // Rebuild + re-layout only when the topology changes; otherwise patch data
  // in place so a status tick never triggers a relayout.
  useEffect(() => {
    const sig = agents.map((a) => a.id).slice().sort().join('|');
    if (sig !== sigRef.current) {
      sigRef.current = sig;
      const cm = buildChainModel(agents);
      const newEdges = buildEdges(agents, cm);
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
      setEdges(buildEdges(agents, buildChainModel(agents)));
    }
  }, [agents, selectedId, setNodes, setEdges]);

  // Reflect externally-driven selection (e.g. ⌘1-9 jumps) onto the nodes.
  useEffect(() => {
    setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === selectedId })));
  }, [selectedId, setNodes]);

  return (
    <DirectorSlotContext.Provider value={director}>
    <div
      style={{
        flex: 1,
        minWidth: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#eceef3',
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
          <Background gap={22} size={1} color="#ced4df" />
          <Controls showInteractive={false} />
        </ReactFlow>
        {agents.length === 0 && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '52%',
              transform: 'translate(-50%, -50%)',
              color: '#5b6473',
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
  );
}
