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
  'claude-opus-4-7': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-opus-4-7[1m]': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.8, outputPerMillion: 4 },
  'claude-haiku-4-5': { inputPerMillion: 0.8, outputPerMillion: 4 },
};

/** Conservative fallback (Sonnet pricing) for unknown model ids. */
const DEFAULT_RATE: ModelRate = { inputPerMillion: 3, outputPerMillion: 15 };

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = RATES[model] ?? DEFAULT_RATE;
  return (
    (inputTokens * rate.inputPerMillion +
      outputTokens * rate.outputPerMillion) /
    1_000_000
  );
}
