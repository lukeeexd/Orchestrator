// data.jsx — DATA SHAPES & EMPTY DEFAULTS
//
// This file documents what data each pane expects.
// In the real app, populate these from your backend / orchestrator state.

// ── Session ────────────────────────────────────────────────────────────────
// The currently-running orchestration. `null` when no session is active.
//
// {
//   id:           string,            // 'sess-d3a91f'
//   title:        string,            // 'Stripe subscriptions in onboarding'
//   startedAt:    string,            // 'HH:MM:SS'
//   elapsed:      string,            // 'MM:SS'
//   totalTokens:  number,
//   totalCost:    number,            // dollars
//   budget:       number,            // dollars
//   director: {
//     model:        string,          // 'claude-sonnet-4.5'
//     tools:        number,
//     contextUsed:  number,          // tokens
//     contextCap:   number,          // tokens
//   }
// }
const SESSION = null;

// ── Director chat messages ────────────────────────────────────────────────
// In session order, oldest first.
//
// {
//   who:   'user' | 'director' | 'system',
//   name:  string,                   // 'will', 'director', 'system'
//   time:  string,                   // 'HH:MM:SS'
//   body:  string,                   // markdown-ish; plain text fine
//   plan?: PLAN,                     // optional embedded plan tree
//   live?: boolean,                  // currently streaming
// }
const MESSAGES = [];

// ── Plan rows (embedded in a director message) ────────────────────────────
// {
//   i:    number,                    // 1-indexed
//   role: 'pm' | 'researcher' | 'coder' | 'qa' | 'devops',
//   name: string,                    // agent id, e.g. 'coder-01'
//   task: string,
// }
const PLAN = [];

// ── Agents ────────────────────────────────────────────────────────────────
// {
//   id:          string,             // unique, used for selection
//   role:        'pm' | 'researcher' | 'coder' | 'qa' | 'devops',
//   roleLabel:   string,             // 'Project Manager'
//   name:        string,             // 'coder-01'
//   status:      'running' | 'waiting' | 'approval' | 'paused' | 'done' | 'error',
//   statusLabel: string,             // 'Running', 'Awaiting handoff', 'Approval needed'
//   step:        string,             // '2/4'
//   task:        string,             // human-readable current step
//   tokens:      number,
//   cost:        number,             // dollars
//   elapsed:     string,             // 'MM:SS'
//   model:       string,
//   log:         LogLine[],          // see below
// }
const AGENTS = [];

// ── Log line ──────────────────────────────────────────────────────────────
// Streamed in order, append-only.
//
// {
//   ts:   string,                    // 'HH:MM:SS.mmm'
//   kind: 'thought' | 'tool' | 'result' | 'warn' | 'error' | 'note' | 'handoff',
//   msg:  string                     // plain message
//      | { fn: string, args: [{ k: string, v: string }] },   // structured tool call
//   live?: boolean,                  // shows a blinking cursor at end
// }

// ── Tools panel (drawer) ──────────────────────────────────────────────────
// Tools granted to the currently-selected agent.
// {
//   name:  string,                   // 'read_file'
//   ns:    string,                   // 'fs', 'sh', 'git', 'meta'
//   count: number,                   // invocations this session
//   last:  string,                   // '4s ago', '—' if unused
// }
const TOOLS_FOR_AGENT = [];

// ── Memory cards (drawer) ─────────────────────────────────────────────────
// Pinned facts + working notes the agent carries between turns.
// {
//   kind: 'pin' | 'note',
//   who:  string,                    // who set it: 'pm-01', 'self', 'user'
//   at:   string,                    // 'HH:MM'
//   body: string,
// }
const MEMORY = [];

// ── Context files (drawer) ────────────────────────────────────────────────
// Files currently held in the agent's context window.
// {
//   path:    string,
//   tk:      number,                 // tokens consumed
//   pinned:  boolean,                // explicitly held vs cache-eligible
// }
const CONTEXT_FILES = [];

// ── Context budget breakdown (drawer) ─────────────────────────────────────
// Segments sum to ≤100. Used to render the stacked horizontal bar.
// {
//   label: string,                   // 'Files', 'History', 'Free'
//   pct:   number,                   // percent of context window
//   color: string,                   // hex
// }
const CTX_SEGS = [];

// ── Templates (rail / picker) ─────────────────────────────────────────────
// Saved orchestration playbooks. Each spawns a preconfigured agent fleet.
// {
//   name: string,                    // 'feature-ship'
//   icon: string,
//   desc: string,
// }
const TEMPLATES = [];

Object.assign(window, {
  SESSION, MESSAGES, PLAN, AGENTS,
  TOOLS_FOR_AGENT, MEMORY, CONTEXT_FILES, CTX_SEGS, TEMPLATES,
});
