// ── Sales voice / no-process-narration guard ──────────────────────────
//
// A customer-facing reply must read like a professional store associate, NOT a
// retrieval log. The bot must never narrate its process: searches, tools, the
// system/catalog/database, filters, "results", "what I'm seeing/getting", or why
// products appeared. This module is the ONE place that defines what process
// narration looks like, so the grounding validator (block + retry) and the final
// emit scrub (remove the offending sentence) agree.
//
// Pure (no DB / no streaming) → unit-testable with fixtures.

// Workflows where a real, sales-voiced answer is owed — process narration here
// is BLOCKING (retry/rewrite before emit), not a warning. multi_recommendation
// is included only when cards are shown (handled by the caller passing hasCards).
export const SALES_VOICE_BLOCKING_WORKFLOWS = new Set([
  "condition_recommendation",
  "named_product_advisory",
  "comparison",
  "availability",
  "prior_evidence_availability",
  "multi_recommendation",
]);

// Sales-judgment workflows that should run on the stronger model first (these
// require taste/voice, where the fast model tends to narrate process).
export const SALES_JUDGMENT_WORKFLOWS = new Set([
  "condition_recommendation",
  "named_product_advisory",
  "comparison",
  "multi_recommendation",
]);

// Process-narration patterns. Each is matched per SENTENCE so the emit scrub can
// remove exactly the offending sentence. Tuned to catch retrieval narration
// while NOT touching normal shopper language (style, size, available, in stock,
// product page, colors, fit, …).
const NARRATION_PATTERNS = [
  // first-person retrieval narration ("I see I'm getting…", "I'm seeing mostly…")
  /\bi\s*(?:'m|’m|\s+am)\s+(?:seeing|getting|finding|pulling(?:\s+up)?|coming\s+up\s+with)\b/i,
  /\bwhat\s+i'?m\s+(?:seeing|getting|finding|pulling)\b/i,
  // "let me pull up a few…", "I'll pull that up", "pull up some options" — the
  // act of fetching, distinct from the first-person "I'm pulling up" above.
  /\b(?:let\s+me|let'?s|i'?ll|i\s+can|i\s+will|i'?d|i\s+would|i'?m\s+going\s+to|give\s+me\s+(?:a\s+)?(?:sec|second|moment|minute))\s+(?:to\s+)?pull\s+(?:up|that\s+up|these\s+up|those\s+up|it\s+up|them\s+up)\b/i,
  /\bpull\s+up\s+(?:some|a\s+few|the|our|these|those|options?|products?)\b/i,
  /\bi\s+see\s+(?:that\s+)?i\s*(?:'m|’m|\s+am)\b/i,
  /\bi\s+(?:see|found|got|am\s+seeing|am\s+getting|notice|noticed)\s+(?:mostly|mainly|only|primarily|a\s+lot\s+of|lots\s+of|a\s+bunch\s+of|a\s+few)\b/i,
  // the act of searching ("let me try one more search", "I'll search", "the search returned/didn't…")
  /\bthe\s+search\b/i,
  /\b(?:let\s+me|let'?s|i'?ll|i\s+can|i\s+will|i\s+could|i\s+should|i'?d|i\s+would|i\s+need\s+to|i\s+want\s+to|i'?m\s+going\s+to|i\s+have\s+to)\s+(?:try\s+(?:another|one\s+more|a\s+(?:different|new|broader|quick|fresh)|again)\s+)?(?:search|re-?search|look\s+that\s+up)\b/i,
  /\b(?:try|run|do|perform|give\s+(?:it|that))\s+(?:another|one\s+more|a(?:nother)?(?:\s+(?:different|new|quick|broader|fresh))?)\s+search\b/i,
  /\bsearch(?:ed|ing)?\s+(?:again|for|the\s+catalog|our\s+catalog|didn|did\s+not|return|returned|came\s+back|pulled|gave|found|turned\s+up)\b/i,
  /\bre-?search(?:ing|ed)?\b/i,
  // system / catalog / data references
  /\bin\s+(?:our|the|my)\s+(?:system|catalog|inventory|database|data|records)\b/i,
  /\bour\s+(?:catalog|system|database|inventory)\b/i,
  /\bthe\s+catalog\b/i,
  /\bcatalog\s+(?:may|might|seems|doesn'?t|does\s+not|is\s+(?:limited|missing)|only\s+has)\b/i,
  /\bfrom\s+the\s+data\s+(?:i|we)\s+(?:have|see|got|can)\b/i,
  /\bbased\s+on\s+(?:the|my|our|what)\s+(?:data|results|search|i'?m\s+seeing)\b/i,
  // meta nouns (guarded so legit shopper words aren't caught)
  /\bsearch\s+results?\b/i,
  /\bthe\s+results?\b/i,
  /\bquer(?:y|ies)\b/i,
  /\b(?:after\s+)?filter(?:ed|ing)\b/i,
  /\b(?:card|product|search|result|candidate)\s+pool\b/i,
  /\b(?:the\s+)?(?:tool|database)s?\b/i,
  // "cards" = our internal term for product tiles — flag unless it's clearly a
  // real product (gift/credit/loyalty/etc. card).
  /\b(?<!gift\s)(?<!credit\s)(?<!debit\s)(?<!loyalty\s)(?<!membership\s)(?<!greeting\s)(?<!business\s)(?<!playing\s)(?<!score\s)(?<!report\s)(?:product\s+|these\s+|those\s+|the\s+|several\s+)?cards?\b(?!\s+(?:accepted|on\s+file|payment))/i,
];

// Split into sentences, keeping it simple (terminal punctuation or newline).
function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isNarrationSentence(sentence) {
  return NARRATION_PATTERNS.some((re) => re.test(sentence));
}

// Detect process narration. Returns { hit, sentences } where `sentences` are the
// exact offending sentences (so the scrub can remove only those).
export function detectProcessNarration(text) {
  const sentences = splitSentences(text);
  const offending = sentences.filter(isNarrationSentence);
  return { hit: offending.length > 0, sentences: offending };
}

// Remove only the process-narration sentences, preserving the rest verbatim.
export function stripProcessNarration(text) {
  const raw = String(text || "");
  if (!raw.trim()) return raw;
  const sentences = splitSentences(raw);
  const kept = sentences.filter((s) => !isNarrationSentence(s));
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

// Whether process narration should BLOCK on this turn (force a retry).
// multi_recommendation only blocks when cards are actually shown.
export function shouldBlockProcessNarration(workflow, hasCards = false) {
  if (!SALES_VOICE_BLOCKING_WORKFLOWS.has(workflow)) return false;
  if (workflow === "multi_recommendation") return Boolean(hasCards);
  return true;
}

// The retry instruction handed back to the model when process narration blocks.
export const PROCESS_NARRATION_RETRY_INSTRUCTION =
  "Rewrite this as a customer-facing retail answer. Do not mention searches, " +
  "tools, system, catalog, data, filters, results, or what you tried. Start " +
  "with the recommendation. Keep it concise and sales-oriented.";

// Sales-safe fallback when the scrub leaves a fragment (or nothing). Warm,
// recommendation-first, NEVER a process apology or "I'm not finding a clean
// match". Workflow-aware; uses the fact that cards are shown.
export function buildSalesVoiceFallback({ workflow = "", hasCards = false } = {}) {
  if (hasCards) {
    switch (workflow) {
      case "comparison":
        return "Here's how these compare for what you need — take a look at both, and I can go deeper on either one.";
      case "availability":
      case "prior_evidence_availability":
        return "Here's what I'd point you to — take a look, and tell me the size or color you want and I'll confirm it.";
      default:
        // condition_recommendation / named_product_advisory / multi / browse
        return "Here are a few strong options I'd start with for what you described — they're a great fit. Want me to go more polished or more casual?";
    }
  }
  return "Tell me a bit more about what you're after — the occasion, your size, or the look you want — and I'll point you to the best options.";
}

// ── Advisory-quality detectors (enforcement/eval layer, NOT a new owner) ──────
//
// These sit alongside the process-narration guard. They do NOT decide the
// workflow or own cards — they only flag advisory replies that fail the
// professional-salesperson bar, so the grounding validator can block+retry and
// the eval suite can pin the behavior. The advisory workflows they apply to are
// the sales-judgment set (condition_recommendation / named_product_advisory /
// comparison / multi_recommendation).
export const ADVISORY_QUALITY_WORKFLOWS = SALES_JUDGMENT_WORKFLOWS;

// ── 1. Unsupported medical claim ─────────────────────────────────────────────
// Aetrex sells comfort footwear and orthotics — never a treatment or cure. A
// reply must NOT promise to cure / heal / reverse / fix / eliminate / "treat" a
// clinical foot condition or "make the pain go away". Comfort language
// ("supports your arch", "helps with all-day comfort", "designed for") is fine
// and deliberately NOT matched.
const MEDICAL_CLAIM_PATTERNS = [
  // cure / heal / reverse / correct a condition or pain
  /\b(?:cure[sd]?|curing|heal[s]?|healing|reverse[sd]?|reversing|correct[s]?\s+(?:your|the))\s+(?:your\s+|the\s+|any\s+|all\s+(?:of\s+)?(?:your\s+)?)?(?:foot\s+|heel\s+|arch\s+|chronic\s+)?(?:pain|plantar\s+fasciitis|fasciitis|bunions?|neuroma|flat\s+feet|fallen\s+arch(?:es)?|conditions?|problems?|issues?)\b/i,
  // fix / eliminate / get rid of / end pain or a condition
  /\b(?:fix(?:es|ing)?|eliminate[sd]?|eliminating|end[s]?|ends|get(?:s|ting)?\s+rid\s+of|banish(?:es)?)\s+(?:your\s+|the\s+|any\s+|all\s+(?:of\s+)?(?:your\s+)?)?(?:foot\s+|heel\s+|arch\s+|chronic\s+)?(?:pain|discomfort|plantar\s+fasciitis|fasciitis|bunions?|neuroma)\b/i,
  // relieve / treat / soothe / heal a NAMED clinical condition (relieving
  // pressure or fatigue is fine; claiming to relieve plantar fasciitis is a
  // medical effect).
  /\b(?:relieve[sd]?|relieving|treat(?:s|ing)?|soothe[sd]?|soothing|remed(?:y|ies|ying))\s+(?:your\s+|the\s+|any\s+)?(?:plantar\s+fasciitis|fasciitis|bunions?|neuroma|metatarsalgia|your\s+(?:foot\s+)?condition)\b/i,
  // "make your foot pain go away", "makes the pain disappear"
  /\b(?:make[s]?|making)\s+(?:your\s+|the\s+)?(?:foot\s+|heel\s+)?(?:pain|discomfort)\s+(?:go\s+away|disappear|vanish|stop)\b/i,
  // "a cure for plantar fasciitis", "the cure for foot pain"
  /\b(?:a|the|your)?\s*cure\s+for\b/i,
  // clinical/prescriptive framing that oversells a retail product as medicine
  /\b(?:clinically\s+proven|medically\s+proven)\s+to\s+(?:cure|heal|fix|treat|reverse|eliminate)\b/i,
];

export function detectUnsupportedMedicalClaim(text) {
  const sentences = splitSentences(text);
  const offending = sentences.filter((s) => MEDICAL_CLAIM_PATTERNS.some((re) => re.test(s)));
  return { hit: offending.length > 0, sentences: offending };
}

export const MEDICAL_CLAIM_RETRY_INSTRUCTION =
  "Your draft promises to cure, heal, fix, relieve, or treat a foot condition — " +
  "Aetrex products are comfort footwear and orthotics, NOT medical treatments, so " +
  "that claim is unsupported and must be removed. Rewrite with honest comfort/support " +
  "language instead: describe the arch support, cushioning, or all-day comfort and who " +
  "it suits, without promising to cure or fix any condition or pain.";

// ── 2. Weak non-answer (message-aware) ───────────────────────────────────────
// A stall — "tell me more", "what's the occasion?", "to help me recommend…" —
// is a non-answer when the customer ALREADY gave enough to recommend: a use
// case/occasion PLUS a category or a condition. A real recommendation lead
// ("I'd start with…", "the Jillian is…") is never flagged, even if it ends with
// a follow-up question.
const USE_CASE_RE = new RegExp(
  "\\b(?:walk(?:ing)?|stand(?:ing)?|on\\s+my\\s+feet|all[-\\s]?day|work(?:ing)?|clinic|hospital|nurse|nursing|teacher|wedding|vacation|travel(?:ing|ling)?|run(?:ning)?|gym|workout|hik(?:e|ing)|everyday|office|party|formal|dress(?:y|\\s+up)?|commut(?:e|ing)|shift|errands?|casual)\\b",
  "i",
);
const CATEGORY_RE = new RegExp(
  "\\b(?:shoe[s]?|sneaker[s]?|sandal[s]?|boot[s]?|flat[s]?|heel[s]?|loafer[s]?|slipper[s]?|clog[s]?|orthotic[s]?|insole[s]?|footbed[s]?|slide[s]?|mule[s]?)\\b",
  "i",
);
const CONDITION_RE = new RegExp(
  "\\b(?:plantar\\s+fasciitis|fasciitis|bunion[s]?|neuroma|metatarsal(?:gia)?|overpronat|supinat|flat\\s+feet|fallen\\s+arch(?:es)?|heel\\s+(?:pain|spur)|arch\\s+(?:pain|support)|foot\\s+pain|high\\s+arch(?:es)?)\\b",
  "i",
);

// Did the customer give enough for a real recommendation (use case + a category
// or a condition)?
export function customerGaveEnoughToRecommend(message) {
  const m = String(message || "");
  const hasUseCase = USE_CASE_RE.test(m);
  const hasCategory = CATEGORY_RE.test(m);
  const hasCondition = CONDITION_RE.test(m);
  return hasUseCase && (hasCategory || hasCondition);
}

// A clarifying-stall reply shape (asks the customer to supply more before it
// will recommend).
const WEAK_STALL_RE = new RegExp(
  "\\b(?:tell\\s+me\\s+(?:a\\s+bit\\s+)?more|can\\s+you\\s+tell\\s+me\\s+(?:a\\s+bit\\s+)?more|(?:to\\s+)?help\\s+me\\s+(?:narrow|recommend|find|point|pick)|what\\s+(?:are\\s+you\\s+(?:looking\\s+for|after)|kind\\s+of|type\\s+of|style|occasion|activit)|could\\s+you\\s+(?:tell|share|let\\s+me\\s+know|give\\s+me)|what'?s\\s+the\\s+occasion|a\\s+few\\s+(?:more\\s+)?(?:quick\\s+)?(?:questions|details)|before\\s+i\\s+(?:can\\s+)?recommend|give\\s+me\\s+a\\s+(?:bit\\s+)?more)\\b",
  "i",
);
// A genuine recommendation lead — if present, the reply is NOT a weak stall.
const RECOMMENDATION_LEAD_RE = new RegExp(
  "\\b(?:i'?d\\s+(?:go|start|pick|recommend|reach\\s+for|point\\s+you|suggest)|i\\s+(?:recommend|suggest)|my\\s+(?:pick|top\\s+pick|go[-\\s]?to|first\\s+choice)|start\\s+with|reach\\s+for|check\\s+out\\s+the|here'?s\\s+(?:what|the\\s+one)|the\\s+\\w+\\s+is\\s+(?:my|a\\s+(?:great|strong|solid|perfect)|the\\s+(?:best|one)))\\b",
  "i",
);

export function detectWeakNonAnswer({ text = "", message = "", hasCards = false } = {}) {
  const t = String(text || "").trim();
  if (!t) return { hit: false, reason: "" };
  // If real product cards are shown alongside a recommendation, a trailing
  // refinement question is fine — only a bare stall with no substance is weak.
  if (RECOMMENDATION_LEAD_RE.test(t)) return { hit: false, reason: "has_recommendation" };
  const isStall = WEAK_STALL_RE.test(t) && t.includes("?");
  if (!isStall) return { hit: false, reason: "" };
  if (!customerGaveEnoughToRecommend(message)) return { hit: false, reason: "insufficient_context" };
  // With cards shown, a stall is still weak (the customer got no guidance), but
  // we surface hasCards so the caller can choose a card-aware fallback.
  return { hit: true, reason: hasCards ? "stall_with_cards" : "stall_no_answer" };
}

export const WEAK_NON_ANSWER_RETRY_INSTRUCTION =
  "The customer already told you their use case and either a category or a foot " +
  "condition — that's enough to recommend. Do NOT ask another clarifying question. " +
  "Lead with a concrete pick (name it), one sentence on why it fits what they said, " +
  "and at most one optional tradeoff or alternative. No 'tell me more', no 'what's the occasion'.";
