/**
 * A1: canonical event-log kinds. Shared between main (the writer)
 * and any future renderer-side consumers (F11 run-bundle export,
 * F5 rewind UI). The kind enum is the contract; body shape per
 * kind is documented per-call-site for now — bodies are opaque JSON
 * at the storage layer so adding optional fields to a body doesn't
 * require a migration.
 *
 * Dot-namespaced strings rather than a flat enum so future
 * groupings (`workspace.*`, `provider.*`, `marketplace.*`) compose
 * naturally. New kinds are additive; never rename / remove since
 * older event rows will keep their string verbatim.
 */
export const EventKinds = {
  // Agent lifecycle
  AgentSpawn: 'agent.spawn',
  /** Mutation to any agent field (status, tokens, cost, elapsed, sessionId, model, effort, endedAt, modelUsage). */
  AgentPatch: 'agent.patch',
  AgentLog: 'agent.log',
  AgentDelete: 'agent.delete',
  /** The runner sent a redirect into a resumed session. */
  AgentRedirect: 'agent.redirect',
  /** A new agent forked from another's session. */
  AgentFork: 'agent.fork',
  /** Terminal completion — Director-bound structured payload built. */
  AgentHandoff: 'agent.handoff',

  // Director conversation
  DirectorMessage: 'director.message',
  DirectorMessagePatch: 'director.message_patch',
  DirectorPlanAccepted: 'director.plan_accepted',
  DirectorWipe: 'director.wipe',
  /** F5: user rewound the Director conversation to a specific message. */
  DirectorRewind: 'director.rewind',

  // Notes
  NoteSet: 'note.set',
  NoteDelete: 'note.delete',
} as const;

export type EventKind = (typeof EventKinds)[keyof typeof EventKinds];

/** Set of all known kinds. Useful for filtering / validation. */
export const ALL_EVENT_KINDS: ReadonlySet<EventKind> = new Set(
  Object.values(EventKinds),
);

/** Renderer-facing view of an event row. */
export interface EventRow {
  seq: number;
  projectId: string | null;
  agentId: string | null;
  ts: number;
  kind: EventKind | string;
  /** Parsed JSON body — `null` when the writer didn't attach one. */
  body: unknown;
  schemaV: number;
}
