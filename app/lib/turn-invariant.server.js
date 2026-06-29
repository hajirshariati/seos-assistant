// Turn-invariant violation sink (audit #7).
//
// Ownership / evidence invariants used to be raw `console.warn` calls — visible
// in logs but with no counter, no assertable surface, and nothing a test or a
// health route could read. Route every VIOLATION through here: it still logs
// (same operator-visible line) AND increments an in-process counter keyed by a
// stable code, so evals can assert "zero violations over the corpus" and a
// health route can expose the totals.
//
// In-process only (resets on deploy) — that's the right scope for "did THIS
// build start emitting a new class of violation?". For long-term trends, ship
// the codes to your metrics pipeline from here.

const counters = new Map();

// Record (and log) a turn-invariant violation. `code` is a stable, low-cardinality
// identifier (e.g. "card_not_in_evidence_pool"); `fields` is structured context.
export function recordTurnInvariantViolation(code, fields = {}) {
  const key = String(code || "unknown");
  counters.set(key, (counters.get(key) || 0) + 1);
  const detail = fields && Object.keys(fields).length ? " " + safeJson(fields) : "";
  console.warn(`[turn-invariant] VIOLATION ${key}${detail}`);
}

// Snapshot of all violation counts since process start (or last reset).
export function getTurnInvariantCounters() {
  return Object.fromEntries(counters);
}

// Total across all codes.
export function totalTurnInvariantViolations() {
  let n = 0;
  for (const v of counters.values()) n += v;
  return n;
}

// Test/maintenance helper — clear the counters.
export function resetTurnInvariantCounters() {
  counters.clear();
}

function safeJson(o) {
  try { return JSON.stringify(o); } catch { return "{…}"; }
}
