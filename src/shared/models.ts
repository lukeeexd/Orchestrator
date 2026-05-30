/**
 * Canonical model ids the UI offers in dropdowns. The list is shared
 * between the Settings screen, the Director pane, the spawn form, and
 * the Drawer's redirect form so the user gets consistent options.
 *
 * Custom values typed into settings.json (or saved by older app
 * versions) are preserved at runtime — the pickers add them as a
 * "(custom)" entry rather than silently dropping them.
 *
 * The `-1m` suffix is our pseudo-id for "same base model, 1M context
 * window beta enabled". The runner resolves it to the real model id +
 * the `context-1m-2025-08-07` beta flag at SDK-call time. Claude Code's
 * picker does the same trick — `Opus 4.8 1M` and `Opus 4.8` both report
 * `claude-opus-4-8` as the underlying id.
 *
 * Ordering controls the dropdown order (each base model followed by its
 * 1M variant). The flagship default is set explicitly in
 * `defaultModelForProvider` (DEFAULT_CLAUDE_MODEL), not by list position.
 */
import type { Provider } from './types';

export const KNOWN_MODELS: readonly string[] = [
  'claude-opus-4-8',
  'claude-opus-4-8-1m',
  'claude-opus-4-7',
  'claude-opus-4-7-1m',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

export const MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-8': 'claude-opus-4-8',
  'claude-opus-4-8-1m': 'claude-opus-4-8 · 1M context',
  'claude-opus-4-7': 'claude-opus-4-7',
  'claude-opus-4-7-1m': 'claude-opus-4-7 · 1M context',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5-20251001',
};

/**
 * The canonical id we record for codex agents. We don't actually pass
 * `-m gpt-5-codex` on the wire (ChatGPT-plan accounts reject explicit
 * model selection with a 400), but we store the agent's effective model
 * as this so the Spend screen + Drawer can show a meaningful label
 * and the rate table can estimate a cost.
 */
export const DEFAULT_CODEX_MODEL = 'gpt-5-codex';

/**
 * The flagship claude default — Opus 4.8 with the 1M-context beta. Used by
 * `defaultModelForProvider` for the Director, new agents, and fresh state when
 * nothing else is saved.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8-1m';

/** Which provider's CLI accepts a given model id. Used to filter the picker. */
export function modelProvider(id: string): Provider {
  if (id.startsWith('gpt-')) return 'codex';
  if (id.startsWith('claude-')) return 'claude';
  // Empty / unknown → no preference; either provider may consume it.
  return 'claude';
}

/**
 * Models a given provider can be pointed at by id. Codex returns an
 * empty list — ChatGPT-plan users can't specify a model explicitly, and
 * we don't want to ship a list that 400's. The picker shows a managed
 * read-only label instead.
 */
export function modelsForProvider(provider: Provider): readonly string[] {
  if (provider === 'codex') return [];
  return KNOWN_MODELS.filter((m) => modelProvider(m) === provider);
}

/**
 * Default model id to use when nothing else is set. Codex returns the
 * canonical codex id so storage / display / cost-estimation all agree;
 * the runner itself decides whether to pass -m (it doesn't, for codex).
 */
export function defaultModelForProvider(provider: Provider): string {
  if (provider === 'codex') return DEFAULT_CODEX_MODEL;
  return DEFAULT_CLAUDE_MODEL;
}

/**
 * Cheapest model for throwaway second-opinion calls (e.g. the N7 Plan Critic),
 * the opposite of `defaultModelForProvider`'s flagship. Haiku, no 1M beta.
 * Codex can't pick a model on the ChatGPT plan, so callers skip codex.
 */
export function cheapestModelForProvider(provider: Provider): string {
  if (provider === 'codex') return DEFAULT_CODEX_MODEL;
  return 'claude-haiku-4-5-20251001';
}

/**
 * True iff a model id is compatible with a given provider's CLI. Used
 * as a guard so a stale persisted claude id on a codex project doesn't
 * get passed straight through. Codex accepts only the canonical default
 * for now (no per-model selection support).
 */
export function modelMatchesProvider(id: string, provider: Provider): boolean {
  if (provider === 'codex') return id === DEFAULT_CODEX_MODEL;
  return modelProvider(id) === provider && id !== DEFAULT_CODEX_MODEL;
}

/**
 * F10: per-model context-window size in tokens, for the live
 * context-meter chip on AgentRow. Claude defaults to 200k unless the
 * 1M beta is enabled. Models not listed return null from
 * `modelContextTokens` — the chip falls back to "—" rather than
 * faking a number.
 */
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  'claude-opus-4-8': 200_000,
  'claude-opus-4-8-1m': 1_000_000,
  'claude-opus-4-7': 200_000,
  'claude-opus-4-7-1m': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  // Codex / GPT — best estimate; ChatGPT-plan doesn't expose the
  // effective context per turn, so this is an upper bound and the
  // chip may underestimate utilisation. Better than nothing.
  'gpt-5-codex': 200_000,
};

/**
 * Look up a model's context size. Returns null on unknown ids so the
 * caller can hide / dash-out the chip instead of guessing.
 */
export function modelContextTokens(id: string): number | null {
  return MODEL_CONTEXT_TOKENS[id] ?? null;
}

/**
 * N18: rough offline token estimate (no tokenizer dependency) — the
 * long-standing ~4-chars-per-token rule of thumb for English + code.
 * Real BPE diverges by ~20-30%, so every number this feeds is an
 * estimate ('≈'). Deliberately heuristic: a 50KB+ tokenizer isn't worth
 * pulling in for an at-a-glance "what am I injecting" optimizer.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Beta header that unlocks the 1M token context window. */
const BETA_CONTEXT_1M = 'context-1m-2025-08-07';

/**
 * Translate a picker model id into the (model, betas) pair the SDK
 * actually consumes. The 1M context window is a beta header layered on
 * top of the base model, not a separate model id.
 */
export function resolveModel(id: string): {
  model: string;
  betas?: readonly string[];
} {
  if (id.endsWith('-1m')) {
    return { model: id.slice(0, -3), betas: [BETA_CONTEXT_1M] };
  }
  return { model: id };
}
