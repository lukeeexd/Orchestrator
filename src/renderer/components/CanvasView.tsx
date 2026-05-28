import { useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import { graphlib, layout as runDagreLayout } from '@dagrejs/dagre';
import '@xyflow/react/dist/style.css';
import type { Agent } from '../../shared/types';
import { ROLE_TINT } from '../../shared/roles';

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
  return (
    <div
      style={{
        width: 150,
        height: NODE_H,
        boxSizing: 'border-box',
        background: '#11161f',
        color: '#eef1f5',
        borderRadius: 12,
        border: '1px solid #1d4ed8',
        boxShadow: '0 6px 18px -8px rgba(20,30,60,0.5)',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 4,
        font: '13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif',
      }}
    >
      <span style={{ fontWeight: 700, letterSpacing: '0.02em' }}>Director</span>
      <span style={{ fontSize: 10.5, color: '#9aa3b2' }}>plans + delegates</span>
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
    const w = n.type === 'director' ? 150 : NODE_W;
    g.setNode(n.id, { width: w, height: NODE_H });
  }
  for (const e of edges) g.setEdge(e.source, e.target);
  runDagreLayout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    const w = n.type === 'director' ? 150 : NODE_W;
    return { ...n, position: { x: p.x - w / 2, y: p.y - NODE_H / 2 } };
  });
}

interface Props {
  agents: Agent[];
  selectedId: string | null;
  onSelectAgent: (id: string | null) => void;
}

export function CanvasView({ agents, selectedId, onSelectAgent }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const sigRef = useRef<string>('');

  // Rebuild + re-layout only when the topology changes; otherwise patch data
  // in place so a status tick never triggers a relayout.
  useEffect(() => {
    const sig = agents.map((a) => a.id).slice().sort().join('|');
    if (sig !== sigRef.current) {
      sigRef.current = sig;
      const rawNodes: Node[] = [
        { id: DIRECTOR_ID, type: 'director', position: { x: 0, y: 0 }, data: {} },
        ...agents.map((a) => ({
          id: a.id,
          type: 'agent',
          position: { x: 0, y: 0 },
          data: agentData(a),
          selected: a.id === selectedId,
        })),
      ];
      const rawEdges: Edge[] = agents.map((a) => ({
        id: `e-${a.id}`,
        source: DIRECTOR_ID,
        target: a.id,
        animated: a.status === 'running',
        style: { stroke: '#aab2c0', strokeWidth: 1.5 },
      }));
      setNodes(layoutLR(rawNodes, rawEdges));
      setEdges(rawEdges);
    } else {
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id === DIRECTOR_ID) return n;
          const a = agents.find((x) => x.id === n.id);
          return a ? { ...n, data: agentData(a) } : n;
        }),
      );
      setEdges((prev) =>
        prev.map((e) => {
          const a = agents.find((x) => x.id === e.target);
          return a ? { ...e, animated: a.status === 'running' } : e;
        }),
      );
    }
  }, [agents, selectedId, setNodes, setEdges]);

  // Reflect externally-driven selection (e.g. ⌘1-9 jumps) onto the nodes.
  useEffect(() => {
    setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === selectedId })));
  }, [selectedId, setNodes]);

  return (
    <div style={{ flex: 1, minWidth: 0, height: '100%', background: '#eceef3' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) =>
          onSelectAgent(node.id === DIRECTOR_ID ? null : node.id)
        }
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
          }}
        >
          No agents yet. Spawn a fleet from the Director to see it on the canvas.
        </div>
      )}
    </div>
  );
}
