/**
 * Approximate Anthropic API rates per 1M tokens. Used to estimate live cost
 * before the SDK's `result` event lands (which gives us the authoritative
 * `total_cost_usd`).
 *
 * Update when pricing changes or when new models are added.
 */
interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
}

const RATES: Record<string, ModelRate> = {
  // Opus 4.8 keeps the standing Opus per-token pricing ($15 in / $75 out
  // per 1M). Update if Anthropic publishes a different rate. The -1m and
  // [1m] variants normalise to this base id, so the 1M flavour is priced
  // the same per token.
  'claude-opus-4-8': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-opus-4-7': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-5': { inputPerMillion: 0.8, outputPerMillion: 4 },
  // OpenAI Codex model. ChatGPT-plan users don't actually pay per-token
  // (usage bucketed against plan limits), but we estimate so the
  // Spend screen has a meaningful figure. Update when public pricing
  // changes.
  'gpt-5-codex': { inputPerMillion: 1.25, outputPerMillion: 10 },
};

/** Conservative fallback (Sonnet pricing) for unknown model ids. */
const DEFAULT_RATE: ModelRate = { inputPerMillion: 3, outputPerMillion: 15 };

/**
 * Normalise model identifiers to a stable key the RATES table maps.
 *
 * Three id flavours flow through this code path:
 *   - Our internal picker ids (`claude-opus-4-7-1m`) — the `-1m`
 *     suffix is a pseudo-id for the 1M context beta layered on the
 *     base model.
 *   - The SDK's `modelUsage` keys, which use the bracket form
 *     (`claude-opus-4-7[1m]`) for the same 1M variant.
 *   - The SDK's resolved model id used in turn-level usage emissions
 *     (`claude-opus-4-7` — the base).
 *   - Dated-suffix variants like `claude-haiku-4-5-20251001`.
 *
 * All four collapse to the same base id for rate lookup. Without
 * this, the `-1m` flavour fell through to the Sonnet fallback rate.
 * M14.
 */
function normaliseModelId(id: string): string {
  let s = id;
  // Drop bracket-style beta annotations (claude-opus-4-7[1m]).
  s = s.replace(/\[[^\]]*\]$/, '');
  // Drop our internal -1m pseudo-suffix.
  if (s.endsWith('-1m')) s = s.slice(0, -3);
  // Drop dated suffixes (claude-haiku-4-5-20251001 → claude-haiku-4-5).
  s = s.replace(/-\d{8}$/, '');
  return s;
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = RATES[normaliseModelId(model)] ?? DEFAULT_RATE;
  return (
    (inputTokens * rate.inputPerMillion +
      outputTokens * rate.outputPerMillion) /
    1_000_000
  );
}
