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
 * picker does the same trick — `Opus 4.7 1M` and `Opus 4.7` both report
 * `claude-opus-4-7` as the underlying id.
 */
import type { Provider } from './types';

export const KNOWN_MODELS: readonly string[] = [
  'claude-opus-4-7',
  'claude-opus-4-7-1m',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-5-codex',
  'gpt-5',
];

export const MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-7': 'claude-opus-4-7',
  'claude-opus-4-7-1m': 'claude-opus-4-7 · 1M context',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5-20251001',
  'gpt-5-codex': 'gpt-5-codex',
  'gpt-5': 'gpt-5',
};

/** Which provider's CLI accepts a given model id. Used to filter the picker. */
export function modelProvider(id: string): Provider {
  if (id.startsWith('gpt-')) return 'codex';
  return 'claude';
}

/** Models a given provider can be pointed at. */
export function modelsForProvider(provider: Provider): readonly string[] {
  return KNOWN_MODELS.filter((m) => modelProvider(m) === provider);
}

/** First model in our list that belongs to a provider — used as default. */
export function defaultModelForProvider(provider: Provider): string {
  return modelsForProvider(provider)[0] ?? 'claude-sonnet-4-6';
}

/**
 * True iff a model id is compatible with a given provider's CLI. Used as a
 * guard so a stale persisted value (e.g. a claude model on a project that
 * was switched to codex) doesn't get passed straight through to a CLI
 * that doesn't recognise it. Unknown-prefix models (someone hand-edited
 * settings.json) currently match no provider; callers fall through to the
 * provider default.
 */
export function modelMatchesProvider(id: string, provider: Provider): boolean {
  return modelProvider(id) === provider;
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
