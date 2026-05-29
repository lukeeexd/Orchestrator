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
import { graphlib, layout as runDagreLayout } from '@dagrejs/dagre';
import '@xyflow/react/dist/style.css';
import type { Agent, EffortLevel, Provider } from '../../shared/types';
import { ROLE_TINT } from '../../shared/roles';
import { Icon } from './Icon';
import { SpawnAgentForm } from './SpawnAgentForm';
import { FocusedFixDialog } from './FocusedFixDialog';
import { OnboardingBanner } from './OnboardingBanner';

/**
 * Flightdeck canvas — Phase 1 (read-only). Mirrors the live agent fleet as a
 * node-graph: a Director anchor node fanning out to one node per agent, laid
 * out left-to-right with dagre. This is an ADDITIVE third `viewMode`; it owns
 * none of the mutation paths yet (selection only). See
 * docs/redesign/flightdeck-implementation-plan.md.
 *
 * Re-layout runs ONLY when the topology (the set of agent ids) changes — see
 * the signature check in the effect below. Status/step ticks update node data
 * in place without moving anything, which is the plan's anti-thrash rule.
 */

const NODE_W = 224;
const NODE_H = 88;
const DIRECTOR_ID = '__director__';

// The Director is a first-class anchor node that hosts the live chat/plan/
// composer (Phase 5c "faithful" — the mockup draws it ON the canvas, wired to
// the agents it spawns). It's a fixed-size, non-draggable box; its content is
// fed in from App via context (see DirectorSlotContext) so message/stream
// ticks reconcile the real DirectorPane in place — scroll, focus, and
// streaming survive — without churning React Flow's node data.
export const DIRECTOR_NODE_W = 384;
const DIRECTOR_NODE_H = 564;

/** Live Director UI piped from App into the `director` node. */
const DirectorSlotContext = createContext<ReactNode>(null);

// Explicit, AA-legible status hues for a light canvas (the app's CSS status
// vars are tuned for the dark terminal theme; on the blueprint canvas we pick
// our own). Deliberately non-terminal-green per the redesign direction.
const STATUS_COLOR: Record<string, string> = {
  running: '#1d4ed8',
  waiting: '#b45309',
  approval: '#b45309',
  paused: '#64748b',
  done: '#3f7d63',
  error: '#dc2626',
  aborted: '#64748b',
};

function agentData(a: Agent): Record<string, unknown> {
  return {
    name: a.name,
    role: a.role,
    roleLabel: a.roleLabel,
    status: a.status,
    statusLabel: a.statusLabel,
    step: a.step,
    subtype: a.subtype ?? '',
  };
}

function AgentNodeView({ data, selected }: NodeProps) {
  const role = String(data.role);
  const tint = ROLE_TINT[role as keyof typeof ROLE_TINT] ?? '#94a3b8';
  const status = String(data.status);
  const sc = STATUS_COLOR[status] ?? '#64748b';
  return (
    <div
      style={{
        width: NODE_W,
        height: NODE_H,
        boxSizing: 'border-box',
        background: '#ffffff',
        borderRadius: 10,
        borderLeft: `3px solid ${tint}`,
        border: `1px solid ${selected ? '#1d4ed8' : '#d4d8e0'}`,
        borderLeftWidth: 3,
        borderLeftColor: tint,
        boxShadow: selected
          ? '0 0 0 2px rgba(29,78,216,0.35), 0 6px 16px -8px rgba(20,30,60,0.35)'
          : '0 4px 12px -8px rgba(20,30,60,0.30)',
        padding: '9px 11px',
        font: '13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif',
        color: '#1f2430',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: sc,
            flexShrink: 0,
            boxShadow: status === 'running' ? `0 0 6px ${sc}` : 'none',
          }}
        />
        <span
          style={{
            fontWeight: 600,
            fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
            fontSize: 12.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {String(data.name)}
        </span>
      </div>
      <div style={{ fontSize: 11, color: tint, fontWeight: 600, marginTop: 3 }}>
        {String(data.roleLabel)}
        {data.subtype ? ` · ${String(data.subtype)}` : ''}
      </div>
      <div
        style={{
          fontSize: 11,
          marginTop: 5,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span style={{ color: sc, fontWeight: 600 }}>
          {String(data.statusLabel)}
        </span>
        <span style={{ color: '#5b6473', fontVariantNumeric: 'tabular-nums' }}>
          step {String(data.step)}
        </span>
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
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { agent: AgentNodeView, director: DirectorNodeView };

function layoutLR(nodes: Node[], edges: Edge[]): Node[] {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 110, marginx: 28, marginy: 28 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    const w = n.type === 'director' ? DIRECTOR_NODE_W : NODE_W;
    const h = n.type === 'director' ? DIRECTOR_NODE_H : NODE_H;
    g.setNode(n.id, { width: w, height: h });
  }
  for (const e of edges) g.setEdge(e.source, e.target);
  runDagreLayout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    const w = n.type === 'director' ? DIRECTOR_NODE_W : NODE_W;
    const h = n.type === 'director' ? DIRECTOR_NODE_H : NODE_H;
    return { ...n, position: { x: p.x - w / 2, y: p.y - h / 2 } };
  });
}

const REDUCE_MOTION =
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Build the edge set that draws the orchestration flow:
 *  - fork ancestry: parent -> fork (dashed), from the existing `forkedFromId`;
 *  - handoff chain: Director-spawned plan agents run sequentially, so start-time
 *    order IS the handoff order — chain each to the next (solid accent). An
 *    explicit `handoffFromId` field is deferred until parallel spawning lands;
 *    until then this is exact, not a heuristic;
 *  - root: Director -> agent for the chain head and any user-spawned standalone
 *    agent.
 * Exactly one incoming edge per agent. Cheap to rebuild on every update.
 */
function buildEdges(agents: Agent[]): Edge[] {
  const ids = new Set(agents.map((a) => a.id));
  const chain = agents
    .filter((a) => a.spawnedBy === 'director' && !a.forkedFromId)
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt);
  const prevOf = new Map<string, string>();
  for (let i = 1; i < chain.length; i++) prevOf.set(chain[i].id, chain[i - 1].id);

  const arrow = (color: string) => ({
    type: MarkerType.ArrowClosed,
    width: 15,
    height: 15,
    color,
  });

  return agents.map((a): Edge => {
    const live = !REDUCE_MOTION && a.status === 'running';
    if (a.forkedFromId && ids.has(a.forkedFromId)) {
      return {
        id: `fork-${a.id}`,
        source: a.forkedFromId,
        target: a.id,
        label: 'fork',
        animated: false,
        markerEnd: arrow('#94a3b8'),
        style: { stroke: '#94a3b8', strokeWidth: 1.5, strokeDasharray: '5 4' },
        labelStyle: { fill: '#5b6473', fontSize: 10, fontFamily: 'system-ui, sans-serif' },
        labelBgStyle: { fill: '#eceef3', fillOpacity: 0.9 },
      };
    }
    const prev = prevOf.get(a.id);
    if (prev) {
      return {
        id: `ho-${a.id}`,
        source: prev,
        target: a.id,
        animated: live,
        markerEnd: arrow('#1d4ed8'),
        style: { stroke: '#1d4ed8', strokeWidth: 1.75 },
      };
    }
    return {
      id: `e-${a.id}`,
      source: DIRECTOR_ID,
      target: a.id,
      animated: live,
      markerEnd: arrow('#9aa3b2'),
      style: { stroke: '#9aa3b2', strokeWidth: 1.5 },
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
      const rawNodes: Node[] = [
        {
          id: DIRECTOR_ID,
          type: 'director',
          position: { x: 0, y: 0 },
          data: {},
          draggable: false,
          selectable: false,
        },
        ...agents.map((a) => ({
          id: a.id,
          type: 'agent',
          position: { x: 0, y: 0 },
          data: agentData(a),
          selected: a.id === selectedId,
        })),
      ];
      const newEdges = buildEdges(agents);
      setNodes(layoutLR(rawNodes, newEdges));
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
            rfRef.current?.fitView({ padding: 0.16, maxZoom: 0.9, duration: 350 }),
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
      setEdges(buildEdges(agents));
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
