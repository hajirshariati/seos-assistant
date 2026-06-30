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

// Canonical END-OF-TURN log. EVERY customer turn must emit exactly one of these
// — whether the agentic LLM loop owned it or a deterministic dispatcher
// (orthotic gate, variant-facts, policy, resolver-no-match, product-engine, …)
// answered and returned BEFORE the loop. Without it, a turn that exits through a
// legacy dispatcher leaves no "who owned this, and how did it end?" record, so a
// silently-wrong owner is invisible in PRD logs. `answerOwner` = who produced the
// text; `cardOwner` = who produced the cards ("none" when suppressed); `path` =
// the code path that owned the turn (e.g. "policy-engine", "agentic-loop").
export function logTurnInvariant({
  workflow = "-", answerOwner = "-", cardOwner = "-", finalCards = "-", path = "-", extra = "",
  // Extended state-ownership fields (Class 1-5 observability). All optional so
  // existing callers keep working; when supplied they make the one-line turn
  // record self-explanatory in PRD logs.
  activeOwner = null, activeProductContext = null, positiveConstraints = null,
  negativeConstraints = null, finalCardOwner = null, invariantFired = null,
} = {}) {
  const fmt = (v) => {
    if (v == null) return null;
    if (v instanceof Set) return [...v].join("|") || "-";
    if (Array.isArray(v)) return v.join("|") || "-";
    if (typeof v === "object") return safeJson(v);
    return String(v);
  };
  const parts = [
    `workflow=${workflow}`,
    `answerOwner=${answerOwner}`,
    `cardOwner=${cardOwner}`,
    `finalCards=${finalCards}`,
    `path=${path}`,
  ];
  if (activeOwner != null) parts.push(`activeOwner=${fmt(activeOwner)}`);
  if (activeProductContext != null) parts.push(`activeProduct=${fmt(activeProductContext)}`);
  if (positiveConstraints != null) parts.push(`positive=${fmt(positiveConstraints) || "-"}`);
  if (negativeConstraints != null) parts.push(`negative=${fmt(negativeConstraints) || "-"}`);
  if (finalCardOwner != null) parts.push(`finalCardOwner=${fmt(finalCardOwner)}`);
  if (invariantFired != null) parts.push(`invariantFired=${fmt(invariantFired) || "none"}`);
  const tail = extra ? ` ${extra}` : "";
  console.log(`[turn-invariant] ${parts.join(" ")}${tail}`);
}

// Registry of every stable invariant code. New hard invariants MUST be listed
// here so eval-turn-invariant can assert the registry stays in sync and no code
// is silently typo'd at a record site.
export const KNOWN_INVARIANT_CODES = new Set([
  // pre-existing
  "orthotic_flow_non_orthotic_cards", "cards_promised_none_shown", "pinned_cards_mutated",
  "comparison_carousel_flood", "comparison_scorer_takeover", "prior_evidence_scorer_takeover",
  "prior_evidence_stray_card", "prior_evidence_zero_cards", "pinned_workflow_scorer_takeover",
  "search_required_not_attempted", "multi_reco_text_card_mismatch", "broad_gender_zero_cards",
  "card_not_in_evidence_pool",
  // 2026-07 state/scope-ownership hardening (this change)
  "current_turn_negation_corrupted_positive_category", "hard_gender_fail_open",
  "stale_width_or_color_applied_to_new_product", "availability_text_card_color_mismatch",
  "handoff_on_catalog_browse", "owner_fallthrough_after_required_gate",
  "shown_card_not_in_active_owner_pool", "pivot_search_scope_leak",
  // 2026-07 support-handoff card-leak + product-spec truth
  "support_handoff_cards_leak", "spec_question_answered_as_availability",
  // 2026-07 support-handoff UI-meta-text leak
  "handoff_meta_text_leak",
]);

// INVARIANT detector (owner_fallthrough_after_required_gate): a REQUIRED gate
// (e.g. the orthotic flow) was active for the turn, yet a different owner took
// over and shipped cards that don't belong to the gate's domain. Pure.
export function ownerFallthroughAfterRequiredGate({ requiredGate = null, finalOwner = null, offDomainCards = 0 } = {}) {
  if (!requiredGate) return false;
  if (finalOwner === requiredGate) return false; // the gate owned it — fine
  return Number(offDomainCards) > 0;
}

// INVARIANT detector (shown_card_not_in_active_owner_pool): every shown card
// must belong to the active owner's candidate pool. Returns the array of stray
// cards (empty when consistent). Identity by handle, then title.
export function shownCardsNotInActiveOwnerPool({ shownCards = [], ownerPool = [] } = {}) {
  const key = (c) => String(c?.handle || c?.title || "").toLowerCase();
  const pool = new Set((Array.isArray(ownerPool) ? ownerPool : []).map(key).filter(Boolean));
  if (pool.size === 0) return [];
  return (Array.isArray(shownCards) ? shownCards : []).filter((c) => {
    const k = key(c);
    return k && !pool.has(k);
  });
}

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
