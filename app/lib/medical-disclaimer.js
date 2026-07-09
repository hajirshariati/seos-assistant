// ── Medical disclaimer layer (permanent, non-removable) ───────────────────────
//
// Aetrex sells comfort footwear and orthotics in a medical-adjacent domain.
// Any turn that answers a CONDITION/PAIN/ORTHOTIC question must carry a short,
// fixed, professional disclaimer that the model cannot override, rewrite, or
// omit — it is appended by CODE at the final emit, after every validator,
// scrub, and repair has run. Pure + testable (same pattern as sales-voice.js).
//
// Scope: deliberately NOT every condition_recommendation turn — "cute sandals
// for vacation" plans to condition_recommendation but is not medical. The
// disclaimer fires when the customer's message (or the reply itself) actually
// mentions a medical condition / foot pain / orthotic therapy.

// Medical condition / pain / orthotic-therapy terms. Mirrors the validator's
// condition vocabulary (grounding-validator PRODUCT_DATA_INTENT_RE) plus the
// orthotic-therapy nouns.
const MEDICAL_TERM_RE = new RegExp(
  "\\b(?:plantar\\s+fasciitis|fasciitis|plantar|bunions?|neuroma|metatarsal(?:gia)?|sesamoid\\w*|capsulitis|" +
  "overpronat\\w*|supinat\\w*|flat\\s+feet|flat[-\\s]?foot|fallen\\s+arch(?:es)?|high\\s+arch(?:es)?|" +
  "heel\\s+(?:pain|spurs?)|arch\\s+pain|foot\\s+pain|feet\\s+(?:hurt|ache|pain)|ankle\\s+pain|knee\\s+pain|" +
  "diabet\\w*|arthrit\\w*|swollen\\s+feet|edema|" +
  "orthotics?|insoles?|inserts?|arch\\s+supports?)\\b",
  "i",
);

// Workflows where a medical-term hit means the ANSWER is condition advice
// (vs. a policy turn that merely quotes the word back).
const MEDICAL_ANSWER_WORKFLOWS = new Set([
  "condition_recommendation",
  "multi_recommendation",
  "named_product_advisory",
  "comparison",
  "compatibility",
  "browse",
  "clarification",
]);

// The fixed disclaimer. One sentence, professional, comfort-positioned —
// NEVER phrased as medical capability (it must not trip the sales-voice
// unsupported-medical-claim detector).
export const MEDICAL_DISCLAIMER_TEXT =
  "Just a note: our recommendations are for comfort and support — for persistent " +
  "or severe foot pain, please check with a podiatrist or your doctor.";

// A short fingerprint used for idempotence: if any disclaimer-shaped sentence
// is already in the reply (from a previous turn's echo or a repeated apply),
// do not stack another.
const DISCLAIMER_PRESENT_RE = /\b(?:podiatrist|not\s+(?:a\s+substitute\s+for\s+)?medical\s+advice|check\s+with\s+(?:a|your)\s+(?:podiatrist|doctor|physician))\b/i;

// Does this turn owe the disclaimer? Message OR reply mentions a medical
// term, on a workflow whose answer is condition advice. Support/policy/handoff
// turns never get it (the workflow set excludes them).
export function medicalDisclaimerRequired({ workflow = "", message = "", text = "" } = {}) {
  if (!MEDICAL_ANSWER_WORKFLOWS.has(String(workflow || ""))) return false;
  return MEDICAL_TERM_RE.test(String(message || "")) || MEDICAL_TERM_RE.test(String(text || ""));
}

// Append the disclaimer (idempotent). Returns { text, applied }.
// Applied AFTER every validator/scrub/repair — the model cannot remove it.
export function applyMedicalDisclaimer({ workflow = "", message = "", text = "" } = {}) {
  const t = String(text || "").trim();
  if (!t) return { text: t, applied: false };
  if (!medicalDisclaimerRequired({ workflow, message, text: t })) return { text: t, applied: false };
  if (DISCLAIMER_PRESENT_RE.test(t)) return { text: t, applied: false };
  return { text: `${t} ${MEDICAL_DISCLAIMER_TEXT}`, applied: true };
}
