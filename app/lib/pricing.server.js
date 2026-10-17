const MODEL_PRICING = {
  "claude-sonnet-4-20250514": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  "claude-sonnet-4-6": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  "claude-haiku-4-5-20251001": { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
  "claude-haiku-4-5": { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
  // Legacy Opus 4 (2025-05) kept at its historical rate.
  "claude-opus-4-20250514": { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  // Opus 4.6+ are $5/$25 per MTok (cache write 1.25x, read 0.1x) —
  // the old $15/$75 entry overstated dashboard costs by 3x.
  "claude-opus-4-6": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
};

const DEFAULT_PRICING = MODEL_PRICING["claude-sonnet-4-6"];

// Embedding (semantic search) pricing — $ per 1M tokens.
// voyage-3 and text-embedding-3-small respectively.
const EMBEDDING_PRICING = { voyage: 0.06, openai: 0.02 };

export function computeCost(model, usage) {
  const p = MODEL_PRICING[model] || DEFAULT_PRICING;
  const input = ((usage.input_tokens || 0) * p.input) / 1_000_000;
  const output = ((usage.output_tokens || 0) * p.output) / 1_000_000;
  const cacheRead = ((usage.cache_read_input_tokens || 0) * p.cacheRead) / 1_000_000;
  const cacheWrite = ((usage.cache_creation_input_tokens || 0) * p.cacheWrite) / 1_000_000;
  return input + output + cacheRead + cacheWrite;
}

export { MODEL_PRICING, EMBEDDING_PRICING };
