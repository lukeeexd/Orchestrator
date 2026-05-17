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
];

export const MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-7': 'claude-opus-4-7',
  'claude-opus-4-7-1m': 'claude-opus-4-7 · 1M context',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5-20251001',
};

/**
 * Sentinel used for "let the CLI pick its own model" — e.g. codex when
 * the user has a ChatGPT account and can't choose a specific model id
 * (`-m gpt-5-codex` returns 400 for ChatGPT-plan users). The runner
 * detects this empty/sentinel value and omits the `-m` flag entirely.
 */
export const PROVIDER_AUTO_MODEL = '';

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
 * empty-string sentinel so the runner omits `-m` and lets the CLI pick.
 */
export function defaultModelForProvider(provider: Provider): string {
  if (provider === 'codex') return PROVIDER_AUTO_MODEL;
  return modelsForProvider(provider)[0] ?? 'claude-sonnet-4-6';
}

/**
 * True iff a model id is compatible with a given provider's CLI. Codex
 * accepts the auto sentinel (empty string). Used as a guard so a stale
 * persisted claude id on a codex project doesn't get passed through.
 */
export function modelMatchesProvider(id: string, provider: Provider): boolean {
  if (provider === 'codex') return id === PROVIDER_AUTO_MODEL;
  return modelProvider(id) === provider && id !== PROVIDER_AUTO_MODEL;
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
