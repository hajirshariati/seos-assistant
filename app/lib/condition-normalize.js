// ── Condition normalization ────────────────────────────────────────────
//
// Map free-text foot-condition vocabulary to ONE canonical condition key. This
// is the single source of truth so a condition can never silently collapse into
// the wrong one (the prod bug: "Morton's neuroma" being written as
// plantar_fasciitis). Pure + order-deterministic → unit-testable.
//
// Returns a canonical key or null. NEVER guesses from a content-free reply
// ("not sure", "maybe") — those return null so no condition is inferred.

// Order matters: most-specific vocabulary first so "heel spur" doesn't read as
// "heel pain", and "ball of foot" reads as metatarsalgia not "none".
const CONDITION_RULES = [
  ["heel_spurs", /\bheel[\s-]?spurs?\b/i],
  ["plantar_fasciitis", /\bplantar[\s-]?fasc(?:i|ii)tis\b|\bplantar[\s-]?fasciitis\b/i],
  ["mortons_neuroma", /\bmorton'?s?[\s-]?neuroma\b|\bneuroma\b/i],
  ["metatarsalgia", /\bmetatarsalgia\b|\bball[\s-]?of[\s-]?(?:the|my|your)?[\s-]*foot\b|\bforefoot[\s-]?pain\b/i],
  ["bunion", /\bbunions?\b/i],
  ["diabetic", /\bdiabet(?:ic|es)\b|\bneuropath/i],
  ["heel_pain", /\bheel[\s-]?pain\b/i],
];

// "No specific condition / just comfort" answers → "none" (a real catch-all the
// resolver understands). Deliberately does NOT include "not sure" / "maybe" /
// "I don't know" — an ambiguous reply is NOT an answer of "no condition".
const NONE_RE =
  /\b(?:no\s+(?:specific\s+)?(?:pain|condition|issue|concern|problems?)|just\s+(?:comfort|support|want\s+(?:comfort|support))|general\s+(?:comfort|support)|everyday\s+(?:comfort|support|wear)|nothing\s+specific|no\s+issues?|none\s+(?:really|specifically)?)\b/i;

// Canonical condition for a free-text snippet, or null if none is clearly stated.
// `allowNone` lets callers opt into the "none" catch-all (the orthotic finder
// uses it so a "just comfort" answer still runs the resolver); leave it off when
// you only want a real clinical condition.
export function conditionFromText(text, { allowNone = false } = {}) {
  const t = String(text || "");
  if (!t.trim()) return null;
  for (const [key, re] of CONDITION_RULES) {
    if (re.test(t)) return key;
  }
  if (allowNone && NONE_RE.test(t)) return "none";
  return null;
}

