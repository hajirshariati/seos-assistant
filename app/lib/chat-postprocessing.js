// Pure heuristic functions for chat post-processing. Extracted from
// chat.jsx so they can be unit-tested without spinning up the full
// agentic loop / Anthropic / Prisma stack.
//
// These functions are the rules that decide:
//   - whether the customer expressed singular vs plural shopping intent
//     (drives the singular-narrow card-pool collapse)
//   - whether the customer is asking to compare items
//     (overrides singular intent — comparison wants both cards)
//   - whether the assistant's response uses pivot phrasing
//     ('we don't have X, but here are Y') — overrides denial logic
//   - whether the assistant's response uses near-match phrasing
//     ('here are our closest options') — overrides denial logic
//
// Production bugs caught by exercising these in isolation:
//   - Bare 'how about' was matching SINGULAR_INTENT_RE, collapsing
//     6-card pools to 1 sandal on category pivots ('how about for
//     women?'). Fix: require a singular reference after 'how about'.

// =====================================================================
// Customer-side intent detection
// =====================================================================

// Singular intent — customer is asking about ONE specific item.
// Triggers the singular-narrow rule (collapse pool to 1 card).
//
// IMPORTANT — known footguns:
//   - 'how about' / 'what about' BARE used to match — this caught
//     category pivots like 'how about for women?' as singular intent.
//     The prior pool collapsed to 1 card. Fixed by requiring a
//     singular reference ('this one', 'the [adj] one') after those
//     phrases.
//   - 'best' / 'cheapest' / 'most X' alone DO match (clear singular
//     superlative — "what's the best" wants ONE answer).
export const SINGULAR_INTENT_RE = /\btell me (?:more |a (?:bit|little) more )?about\b|\bmore (?:info|information|details) (?:on|about)\b|\b(?:what|how) about\s+(?:this|that|the\s+\w+\s+one\b)|\bhow is\b|\bis the\b|\bdoes (?:the|this|that)\b|\b(?:this|that) one\b|\bthe (?:first|second|third|last|cheapest|cheaper|priciest|most expensive|best|top|finest|red|blue|black|white|same)\s+(?:one\b|[a-z'-]+s?\b)|\bwhich\s+[a-z'-]+\s+(?:is|are)\s+(?:best|most|finest|top|the\s+(?:best|most))\b|\bwhat\s*'?s\s+(?:the\s+)?(?:best|cheapest|priciest|most expensive|finest|top|most\s+[a-z'-]+)\b/i;

// Comparison intent — customer wants to see two things side-by-side.
// Overrides singular intent (we want both cards even if phrasing is
// otherwise singular-shaped).
export const COMPARISON_INTENT_RE = /\b(?:compare|comparison|vs\.?|versus|difference between|better between|between [a-z0-9'-]+ (?:and|or) [a-z0-9'-]+|which (?:is|one is) (?:better|worse)|side[- ]by[- ]side)\b/i;

export function detectSingularIntent(text) {
  if (typeof text !== "string" || !text) return false;
  if (!SINGULAR_INTENT_RE.test(text)) return false;
  // Comparison overrides singular: 'which is better, X or Y' is plural
  // even though it matches singular phrasing.
  if (COMPARISON_INTENT_RE.test(text)) return false;
  return true;
}

export function detectComparisonIntent(text) {
  if (typeof text !== "string" || !text) return false;
  return COMPARISON_INTENT_RE.test(text);
}

// =====================================================================
// Assistant-side phrasing detection
// =====================================================================
// These look at the LLM's own reply text to decide whether to apply
// downstream guardrails (saysNoMatch denial, etc.).

// Pivot phrasing: "we don't have X, but [...] here/these/those/our/all
// of these/etc.". Allow up to ~30 chars of filler between 'but' and
// the presentational pronoun so phrases like 'but all of these sandals
// are tagged for bunions' or 'but I do have a few options' count as a
// pivot.
//
// Production trace that motivated this: customer asked for a yellow
// sandal; AI replied 'We don't have an exact yellow option right now,
// but all of these sandals are specifically tagged for bunions...'.
// Without this match, saysNoMatch stayed true, the card pool was
// suppressed, and the customer saw the 'we don't have' apology with
// no products beneath.
const AI_PIVOT_BUT_RE = /\bbut\b[\s\S]{0,30}?\b(?:here|these|those|our|all\s+of\s+(?:these|those|the|them)|every\s+(?:one|single)|each\s+(?:one|of\s+these)|i\s+do(?:\s+have)?|i'?ve\s+got|we\s+do(?:\s+have)?|we'?ve\s+got)\b/i;

// Near-match phrasing: 'closest options', 'nearest match', etc. Same
// override semantics — the AI is presenting alternatives, not denying.
const AI_NEAR_MATCH_RE = /\b(?:closest|nearest|next\s+best|similar)\s+(?:option|options|match|matches|pick|picks|alternative|alternatives)\b/i;

export function detectAiPivotPhrasing(text) {
  if (typeof text !== "string" || !text) return false;
  return AI_PIVOT_BUT_RE.test(text) || AI_NEAR_MATCH_RE.test(text);
}

// =====================================================================
// Suggestion validators (follow-up question filtering)
// =====================================================================
// The LLM occasionally suggests follow-up questions that promise things
// the catalog doesn't have. These filters drop those suggestions before
// they reach the customer.

// Branded tech terms (UltraSKY, OrthoLite, etc.) — the AI's catalog
// data has marketing descriptions but not engineering specs, so a
// follow-up like 'tell me more about UltraSKY' triggers hallucination.
const TECH_NAME_RE = /(?:[™®]|\b[A-Z][A-Za-z]*(?:[A-Z][A-Za-z]+){1,}\b)/;

// "Tell me more about" / "explain how X works" / "what is the [tech]"
// — same hallucination risk.
const SPEC_DEEPDIVE_RE = /\b(?:tell me more about|explain|how does .* work|what (?:is|are) the (?:[a-z]+\s+)?(?:technology|system|fabric|foam|material|tech)|details?\s+(?:on|about)\s+the)\b/i;

// Specific spec/measurement asks — same hallucination risk unless
// those numbers actually appear in the assistant's previous reply.
const SPEC_MEASURE_RE = /\b(?:heel\s+height|stack\s+height|toe\s+drop|heel-to-toe\s+drop|stack|gradient|density|grade|weight\s+in\s+(?:oz|grams|g)|dimensions|cm\b|mm\b)\b/i;

/**
 * Decide whether a follow-up suggestion question is safe to show.
 * Returns { allowed: boolean, reason: string|null }.
 *
 * @param {string} suggestion  candidate follow-up question
 * @param {string} replyText   assistant's last reply (for context match)
 */
export function validateFollowUpSuggestion(suggestion, replyText) {
  const q = String(suggestion || "");
  const reply = String(replyText || "");
  const replyLower = reply.toLowerCase();

  // Tech-name deepdive — only allow if the exact tech term appeared in
  // the reply.
  if (SPEC_DEEPDIVE_RE.test(q)) {
    const techMatches = q.match(TECH_NAME_RE);
    if (!techMatches) {
      // A deepdive question without a specific tech term anchor — drop.
      return { allowed: false, reason: "spec deepdive without tech anchor" };
    }
    const techTerm = techMatches[0];
    if (!replyLower.includes(techTerm.toLowerCase())) {
      return { allowed: false, reason: `tech term "${techTerm}" not in reply` };
    }
  }

  // Branded tech term anywhere in the suggestion (e.g. "Do you have
  // UltraSKY foam in red?") — drop unless that exact term appears in
  // the reply.
  if (TECH_NAME_RE.test(q)) {
    const techMatches = q.match(TECH_NAME_RE);
    for (const term of techMatches || []) {
      if (term.length < 4) continue; // skip ™/® alone
      if (!replyLower.includes(term.toLowerCase())) {
        return { allowed: false, reason: `branded tech term "${term}" not in reply` };
      }
    }
  }

  // Spec measurement — drop unless the same measurement appears in the
  // reply (we can't fact-check arbitrary numbers).
  if (SPEC_MEASURE_RE.test(q) && !SPEC_MEASURE_RE.test(reply)) {
    return { allowed: false, reason: "spec measurement not in reply" };
  }

  return { allowed: true, reason: null };
}

// =====================================================================
// Customer-rejected category detection + chip stripping
// =====================================================================
// When the customer says "I don't like shoes" / "no sandals", the AI
// sometimes still offers chips for those exact categories. This pair
// of functions detects rejected categories from the customer's latest
// message and removes matching <<Label>> chips from the AI reply.

// Shopping-rejection phrasing. Bare "not" used to be a trigger and
// caused production false-positives: "but L2305 is not good for
// flat feet" used to add "flat" and "orthotic" to
// rejectedCategories, poisoning every subsequent turn. Fix:
//   1. Drop bare "not", "don't", "doesn't", "didn't" — require the
//      shopping verb (like/want/need/care/etc.) to disambiguate
//      from evaluation phrasing ("not good for X", "doesn't apply").
//   2. Require category nouns to be plural ("flats" not "flat") to
//      avoid matching "no, my feet are flat" or "flat arches".
//   3. Keep "no" but only when not followed by an evaluation cue
//      (handled by the must-be-followed-by-category constraint —
//      "no good for X" doesn't have a category noun after "no").
const REJECT_RE = /\b(?:no|don'?t[\s-]?(?:like|want|need|care\s+for|carry|have|do)|do\s+not\s+(?:like|want|need|care\s+for|carry|have|do)|doesn'?t[\s-]?(?:like|want|need|care\s+for|carry|have|do)|does\s+not\s+(?:like|want|need|care\s+for|carry|have|do)|didn'?t[\s-]?(?:like|want|need|care\s+for)|did\s+not\s+(?:like|want|need|care\s+for)|hate|hates|dislike|dislikes|avoid|avoids|avoiding|without|besides|other[\s-]?than|except[\s-]?for|except|instead[\s-]?of|rather[\s-]?than|not[\s-]?into|not[\s-]?a[\s-]?fan|not[\s-]?interested[\s-]?in)\b[^.!?\n]{0,50}\b((?:shoes?|footwear|orthotics?|insoles?|footbeds?|sandals?|sneakers?|boots?|clogs?|loafers?|slippers?|oxfords?|wedges?|heels?|flats|mules?|mary[\s-]?janes?|slip[\s-]?ons?))\b/gi;

// Footwear umbrella — "shoes" / "footwear" rejects all member
// categories. Chip filter expects exact category labels, so we
// expand the umbrella term into its members.
const FOOTWEAR_UMBRELLA_MEMBERS = [
  "sandals", "sneakers", "boots", "clogs", "loafers", "slippers",
  "oxfords", "wedges heels", "wedges", "heels", "flats", "mules",
  "mary janes", "slip ons", "footwear",
];

export function detectRejectedCategories(text) {
  const out = new Set();
  if (typeof text !== "string" || !text) return out;
  REJECT_RE.lastIndex = 0;
  let m;
  while ((m = REJECT_RE.exec(text)) !== null) {
    const term = m[1].toLowerCase().replace(/\s+/g, " ").trim();
    out.add(term);
    if (term === "shoes" || term === "shoe" || term === "footwear") {
      FOOTWEAR_UMBRELLA_MEMBERS.forEach((c) => out.add(c));
    }
  }
  return out;
}

/**
 * Remove <<Label>> chips whose normalized label matches any rejected
 * term (exact match or singular/plural stem match).
 *
 * @param {string} text       full assistant reply
 * @param {Set<string>} rejected  rejected category terms
 * @returns {{ text: string, stripped: string[] }}
 */
export function stripRejectedCategoryChips(text, rejected) {
  if (!text || !rejected || rejected.size === 0) {
    return { text: text || "", stripped: [] };
  }
  const stripped = [];
  let out = String(text).replace(/<<\s*([^<>]+?)\s*>>/g, (full, label) => {
    const norm = String(label).toLowerCase().trim().replace(/\s+/g, " ");
    const stem = norm.endsWith("s") ? norm.slice(0, -1) : norm;
    for (const t of rejected) {
      const tStem = t.endsWith("s") ? t.slice(0, -1) : t;
      if (norm === t || stem === tStem || stem === t || norm === tStem) {
        stripped.push(label);
        return "";
      }
    }
    return full;
  });
  if (stripped.length > 0) {
    out = out.replace(/[ \t]{2,}/g, " ").trim();
  }
  return { text: out, stripped };
}

// =====================================================================
// Tool-call syntax stripping
// =====================================================================
// Belt-and-suspenders against the model leaking control tokens in its
// reply. Customers should never see XML-ish or JSON-ish control
// fragments. Patterns observed: <function_calls>, search_products {…},
// recommend_orthotic {…}, <invoke name="…">, etc.

export function stripToolCallSyntax(text) {
  if (!text) return text;
  let out = String(text);
  out = out.replace(/<\/?(?:function_calls|invoke|antml:[a-z_]+|parameter)[^>]*>/gi, "");
  out = out.replace(
    /\b(?:search_products|get_product_details|lookup_sku|find_similar_products|recommend_[a-z_]+|get_customer_orders|get_product_reviews|get_return_insights|get_fit_recommendation)\s*\{[\s\S]*?\}\s*/gi,
    "",
  );
  out = out.replace(
    /^\s*(?:search_products|get_product_details|lookup_sku|find_similar_products|recommend_[a-z_]+)\s+(?=[A-Z])/i,
    "",
  );
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
  return out;
}

// =====================================================================
// Hallucinated stock-claim detection
// =====================================================================
// The model sometimes generates "currently available in size 9 wide"
// without the get_product_details tool ever firing. This is a pattern
// from training data — never a real signal. Detect and strip.

export const STOCK_CLAIM_RE =
  /\b(?:currently |right now |presently )?(?:available|in stock|we have (?:(?:it|them|these|those|that|this|some))?)\s+(?:in\s+)?(?:size\s+)?(?:\d+(?:\.\d+)?(?:[\s-](?:wide|narrow|x-?wide|w|n|m|d|ee|eee))?|wide|narrow|x-?wide)\b/i;

export function detectStockClaim(text) {
  if (typeof text !== "string" || !text) return false;
  return STOCK_CLAIM_RE.test(text);
}

/**
 * Strip a hallucinated stock-claim phrase and append an honest
 * deferral. Caller decides whether get_product_details was invoked
 * this turn — only call this when it WASN'T.
 */
export function stripStockClaim(text) {
  if (!text) return "";
  let out = String(text)
    .replace(STOCK_CLAIM_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim();
  if (out && !/[.!?]$/.test(out)) out += ".";
  return (out + " I can't check live stock from here — the product page or our support team can confirm the size.").trim();
}

// =====================================================================
// Yes/No Q&A pattern detection
// =====================================================================
// When the customer asks a yes/no question and the AI opens with
// yes/no, the customer wants a direct answer — not a fresh card grid.
// Use these to suppress the card pool in that case.

const YESNO_QUESTION_RE = /^\s*(?:do(?:es)?|did|will|would|can|could|is|are|was|were|has|have|had|should|may|might)\b[^?!.\n]{0,140}\?/i;
const YESNO_ANSWER_RE = /^\s*(?:yes|yeah|yep|yup|absolutely|definitely|correct|right|exactly|sure|of course|no\b|nope|not really|unfortunately,?\s+no|sadly,?\s+no)/i;

// When the AI's reply, after the yes/no opener, signals it is ABOUT to
// present products ("here are…", "take a look at…", "check out…"), the
// customer's yes/no question was actually a request to see options.
// Don't suppress cards in that case.
const PRODUCT_PRESENTATION_RE = /\b(here(?:'s| is| are)|there\s+(?:is|are)|take a look|check (?:out|these)|i(?:'ve| have) (?:got|found|pulled)|let me show|below are|the following|we\s+(?:have|carry))\b/i;

// Generic tokens that appear in product titles but are not distinctive
// product names. If a title's leading token is one of these, it's not
// reliable as a "did the AI mention this product" signal.
const GENERIC_TITLE_TOKENS = new Set([
  "men", "mens", "men's", "women", "womens", "women's", "kids", "kid",
  "unisex", "the", "a", "an",
  "black", "white", "navy", "tan", "brown", "grey", "gray", "beige",
  "red", "blue", "green", "pink", "cream", "ivory", "champagne", "sage",
  "orthotic", "orthotics", "insole", "insoles", "shoe", "shoes",
  "sneaker", "sneakers", "sandal", "sandals", "loafer", "loafers",
  "boot", "boots", "clog", "clogs", "slipper", "slippers",
]);

function distinctiveTitleTokens(title) {
  if (typeof title !== "string") return [];
  // Take everything before the first " - " (color/variant suffix) and
  // split on whitespace + non-alphanumeric. Keep tokens 3+ chars that
  // aren't in GENERIC_TITLE_TOKENS.
  const base = title.split(/\s+-\s+/)[0] || title;
  return base
    .toLowerCase()
    .split(/[^a-z0-9®™]+/)
    .filter((t) => t.length >= 3 && !GENERIC_TITLE_TOKENS.has(t));
}

/**
 * Does the AI's reply text mention any product from the candidate pool
 * by a distinctive name token? "Distinctive" excludes color words,
 * gender words, and category nouns (sneaker, loafer, etc) that show
 * up in every other title.
 *
 * This is the ground-truth signal that the AI is presenting products,
 * independent of the opener phrase ("here are" vs "there are" vs
 * "we have" vs no opener at all). If the AI named Leigh/Gianna/Elise,
 * those cards must be shown — phrasing is irrelevant.
 */
function mentionsAnyPoolProduct(text, pool) {
  if (typeof text !== "string" || !text || !Array.isArray(pool) || pool.length === 0) {
    return false;
  }
  const lower = text.toLowerCase();
  for (const p of pool) {
    const tokens = distinctiveTitleTokens(p?.title);
    for (const t of tokens) {
      // Word-boundary match so "leigh" doesn't match "high".
      const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(lower)) return true;
    }
  }
  return false;
}

export function isYesNoQuestion(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length < 200 && YESNO_QUESTION_RE.test(trimmed);
}

export function isYesNoAnswer(text, pool = []) {
  if (typeof text !== "string" || !text) return false;
  if (!YESNO_ANSWER_RE.test(text)) return false;
  // Pool-grounded check (primary signal). If the AI named any
  // product from the pool, this is a product presentation regardless
  // of opener phrasing. Cards must go through.
  if (mentionsAnyPoolProduct(text, pool)) return false;
  // Legacy opener-shape fallback for cases where pool is empty,
  // titles share generic tokens, or text doesn't actually mention
  // pool items but does use a "here are…" preamble.
  if (PRODUCT_PRESENTATION_RE.test(text)) return false;
  return true;
}

// =====================================================================
// Signup / newsletter intent detection
// =====================================================================
// When either side mentions newsletter / signup / mailing list, we
// emit a Klaviyo form CTA. Detection is intentionally broad — better
// to over-trigger and let the customer dismiss than miss the moment.

const USER_SIGNUP_RE = /\b(sign ?up for (our|the|your|a).{0,25}(newsletter|list|email|sms|updates|deals|offers)|subscribe to (our|the|your).{0,20}(newsletter|list|email|sms|updates)|newsletter|mailing list|join our (list|newsletter|email|sms)|opt.?in|stay (connected|in touch|updated).{0,20}(email|offers|updates|news|deals))\b/i;
const AI_SIGNUP_RE = /\b(newsletter|mailing list|subscribe to (our|the|your).{0,20}(newsletter|list|sms|email)|sign ?up for (our|the|my|your).{0,25}(newsletter|list|email|sms|updates|deals|offers)|join our (newsletter|list|email|sms)|stay connected.{0,20}(email|offers|updates|deals))\b/i;

export function detectUserSignupIntent(text) {
  if (typeof text !== "string" || !text) return false;
  return USER_SIGNUP_RE.test(text);
}

export function detectAiSignupMention(text) {
  if (typeof text !== "string" || !text) return false;
  return AI_SIGNUP_RE.test(text);
}

// =====================================================================
// Tool-call text leak scrub
// =====================================================================
// When the LLM gets confused (especially under prompt rules pushing
// "tool first"), it occasionally writes the tool call as plain text
// instead of using the proper tool_use mechanism. Patterns observed:
//   <template_name>search_products</template_name> <template_params>{...}</template_params>
//   <search_products><query>...</query><filters>...</filters></search_products>
//   search_products { "query": "...", "filters": {...} }
// Production with tools registered usually doesn't hit this, but the
// eval (no tools) and rare production confusion both can. Strip these
// patterns before they reach the customer.

const TOOL_LEAK_PATTERNS = [
  // <template_name>X</template_name> <template_params>{...}</template_params> blocks
  /<template_name>[\s\S]*?<\/template_name>\s*<template_params>[\s\S]*?<\/template_params>/gi,
  // bare <template_name>...</template_name> or <template_params>...</template_params>
  /<\/?template_(?:name|params)>[\s\S]*?<\/?template_(?:name|params)>/gi,
  /<template_(?:name|params)>[\s\S]{0,500}?(?:<\/template_(?:name|params)>|$)/gi,
  // <search_products><query>...</query><filters>...</filters></search_products> blocks
  /<(?:search_products|lookup_sku|find_similar_products|get_product_details)>[\s\S]*?<\/(?:search_products|lookup_sku|find_similar_products|get_product_details)>/gi,
  // bare tool-name { json-ish args } at start of line or sentence
  /(?:^|\n|\s)(?:search_products|lookup_sku|find_similar_products|get_product_details|get_product_reviews|get_return_insights|get_fit_recommendation|get_customer_orders)\s*\{[\s\S]*?\}(?=\s|$)/gi,
];

export function scrubToolCallLeaks(text) {
  if (!text || typeof text !== "string") return { text: text || "", changed: false };
  let out = text;
  for (const re of TOOL_LEAK_PATTERNS) {
    out = out.replace(re, " ");
  }
  out = out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, changed: out !== text.trim() };
}

// =====================================================================
// Role-marker scrub
// =====================================================================
// If the model literally generates "Human:" / "Assistant:" tokens in
// its reply (rare but observed in long sessions when sanitizeHistory
// missed an inbound leak), scrub them. Returns the cleaned text plus
// a flag so the caller can choose to keep the original if cleaning
// would leave a near-empty string.

export function scrubRoleMarkers(text) {
  if (!text || typeof text !== "string") {
    return { text: text || "", changed: false, candidate: text || "" };
  }
  if (!/\b(?:Human|Assistant)\s*:/i.test(text)) {
    return { text, changed: false, candidate: text };
  }
  const candidate = text
    .replace(/^\s*(?:Human|Assistant)\s*:\s*/i, "")
    .replace(/\n\s*(?:Human|Assistant)\s*:\s*/gi, "\n")
    .replace(/\s*(?:Human|Assistant)\s*:\s*/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  // Defensive: caller should keep original if candidate is too short.
  // If the entire reply was a role-marker fragment with nothing else,
  // stripping leaves "" — empty-pool repair downstream needs SOMETHING
  // to react to.
  if (candidate.length < 5) {
    return { text, changed: false, candidate };
  }
  return { text: candidate, changed: candidate !== text, candidate };
}

// =====================================================================
// Internal-language leak scrub (M1 stabilization)
// =====================================================================
//
// The resolver-state block in the system prompt occasionally bleeds
// into customer-facing text — the model writes "the resolver state
// indicates", "based on matched_constraints", "the catalog facts
// show", etc. These are internal terms the customer must never see.
//
// Two-stage scrub:
//   1. Strip known lead-in phrases ("The resolver state indicates",
//      "Based on the resolver state", etc.) and lowercase-fix the
//      next character so the sentence still reads naturally.
//   2. If a forbidden internal TERM still appears anywhere in the
//      text, the reply is unsafe to ship — replace the whole reply
//      with a neutral clarification line.

const RESOLVER_LEAD_IN_RE = new RegExp(
  // Optional opening connector + a leak phrase, eaten through the
  // next verb (indicates / shows / says / is / says that …).
  "(?:^|(?<=[.!?]\\s)|(?<=\\n))" +
    "(?:" +
      // resolver-/catalog-state mentions
      "(?:based\\s+on|according\\s+to|per|looking\\s+at|from)\\s+" +
        "(?:the\\s+)?(?:resolver(?:_|\\s+)?state|resolver|catalog\\s+facts?|matched(?:_|\\s+)?constraints?|inferred(?:_|\\s+)?constraints?|recommended(?:_|\\s+)?next(?:_|\\s+)?action|candidate(?:_|\\s+)?products?|system\\s+prompt|tool\\s+(?:call|results?))" +
        "[,:\\s][^.!?\\n]{0,40}?(?:indicates?|shows?|says?|states?|tells?\\s+me|is|are)\\b\\s*(?:that\\s+)?" +
      "|" +
      // direct "the resolver state X" / "matched_constraints X"
      "(?:the\\s+)?(?:resolver(?:_|\\s+)?state|matched(?:_|\\s+)?constraints?|inferred(?:_|\\s+)?constraints?|recommended(?:_|\\s+)?next(?:_|\\s+)?action|candidate(?:_|\\s+)?products?)" +
        "\\s+(?:indicates?|shows?|says?|states?|tells?\\s+me|is|are)\\b\\s*(?:that\\s+)?" +
      "|" +
      // "I'll run a live search because the resolver said"
      "(?:i'?ll|let\\s+me|i\\s+will)\\s+(?:run|do|trigger)\\s+(?:a\\s+)?(?:live\\s+)?search\\s+(?:because|since)\\s+(?:the\\s+)?resolver[^.!?\\n]{0,40}?[.!?]?" +
    ")",
  "gi",
);

// Forbidden TERMS that must never appear in customer-facing text,
// even after lead-in phrases are stripped.
const FORBIDDEN_INTERNAL_TERMS_RE = new RegExp(
  "\\b(?:" +
    "resolver(?:_|\\s+)?state" + "|" +
    "matched(?:_|\\s+)?constraints?" + "|" +
    "inferred(?:_|\\s+)?constraints?" + "|" +
    "impossible(?:_|\\s+)?constraints?" + "|" +
    "remaining(?:_|\\s+)?disambiguators?" + "|" +
    "recommended(?:_|\\s+)?next(?:_|\\s+)?action" + "|" +
    "candidate(?:_|\\s+)?products?" + "|" +
    "do(?:_|\\s+)?not(?:_|\\s+)?ask" + "|" +
    "system\\s+prompt" + "|" +
    "tool\\s+call" + "|" +
    "search\\s+because\\s+resolver" +
  ")\\b",
  "i",
);

const INTERNAL_LEAK_FALLBACK =
  "I'm not finding a clean match for that exact request right now. Want me to widen the search, or tell me a bit more about what you're after?";

export function containsInternalLanguageLeak(text) {
  if (!text || typeof text !== "string") return false;
  return FORBIDDEN_INTERNAL_TERMS_RE.test(text);
}

export function stripInternalLeaks(text, { fallback = INTERNAL_LEAK_FALLBACK } = {}) {
  if (!text || typeof text !== "string") return { text: text || "", changed: false, replaced: false };
  const original = text;

  // Stage 1: strip lead-in phrases, then capitalize the resulting
  // sentence start so "there are no men's options" → "There are…".
  let out = text.replace(RESOLVER_LEAD_IN_RE, "").replace(/\s{2,}/g, " ").trim();
  out = out.replace(/(^|[.!?]\s+|\n)([a-z])/g, (_, lead, ch) => lead + ch.toUpperCase());

  // Stage 2: if any forbidden term still remains, the reply isn't
  // safe to ship — swap the whole thing for the neutral fallback.
  if (FORBIDDEN_INTERNAL_TERMS_RE.test(out)) {
    return { text: fallback, changed: true, replaced: true };
  }

  // If the lead-in strip emptied the response (the leak WAS the
  // whole sentence and nothing else), use the fallback too.
  if (out.length < 8) {
    return { text: fallback, changed: true, replaced: true };
  }
  return { text: out, changed: out !== original.trim(), replaced: false };
}

// =====================================================================
// Orthotic internal-enum scrub (R5)
// =====================================================================
//
// The orthotic decision tree speaks in internal tokens — node ids
// (q_arch, q_use_case) and snake_case attribute values
// (overpronation_flat_feet, comfort_walking_everyday, plantar_fasciitis,
// …). Those are FACTS the code owns; the customer must never see them.
//
// One mapping (token -> friendly label) is the single source of truth,
// and one scrub applied at the emit boundary guarantees no internal
// token survives into customer-facing text, even if the model or a code
// path interpolates one. Node ids are removed outright (they are never
// customer-facing); known value tokens become their friendly label;
// any unmapped-but-enum-shaped value is humanized (underscores -> spaces)
// so a raw enum can never leak.
const ORTHOTIC_ENUM_LABELS = {
  // arch
  low_arch: "low arches",
  high_arch: "high arches",
  medium_arch: "medium arches",
  normal_arch: "neutral arches",
  neutral_arch: "neutral arches",
  flat_arch: "flat arches",
  // condition
  plantar_fasciitis: "plantar fasciitis",
  heel_spurs: "heel spurs",
  metatarsalgia: "ball-of-foot pain",
  mortons_neuroma: "Morton's neuroma",
  overpronation_flat_feet: "flat feet or overpronation",
  arch_pain: "arch pain",
  heel_pain: "heel pain",
  foot_pain: "foot pain",
  diabetic: "diabetic foot care",
  // useCase
  comfort_walking_everyday: "everyday walking",
  comfort_memory_foam_everyday: "everyday memory-foam comfort",
  comfort_memory_foam: "memory-foam comfort",
  comfort_bundle: "all-day comfort",
  athletic_running: "running",
  athletic_training_sports: "sports training",
  athletic_training_gym: "gym training",
  athletic_training: "gym or training",
  athletic_general: "athletic or court",
  dress_no_removable: "dress shoes without a removable insole",
  dress_premium: "premium dress shoes",
  boots_construction: "work boots",
  winter_boots: "winter boots",
  work_all_day: "long days on your feet",
  non_removable: "shoes without a removable insole",
};

export function friendlyEnumLabel(token) {
  if (token == null) return "";
  const key = String(token).trim().toLowerCase();
  if (ORTHOTIC_ENUM_LABELS[key]) return ORTHOTIC_ENUM_LABELS[key];
  // Unmapped but enum-shaped → humanize so a raw snake_case token never
  // reaches the customer.
  if (/^[a-z]{2,}(?:_[a-z0-9]+)+$/.test(key)) return key.replace(/_/g, " ");
  return String(token);
}

const INTERNAL_NODE_ID_RE = /\bq_[a-z][a-z0-9_]*/gi;
const ORTHOTIC_ENUM_TOKEN_RE = new RegExp(
  "\\b(?:" +
    Object.keys(ORTHOTIC_ENUM_LABELS)
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|") +
    ")\\b",
  "gi",
);
// Any snake_case identifier. In customer-facing prose this is virtually
// always an internal token leaking through — humanize it. URLs (where
// underscores are legitimate) are masked out first so links survive.
const ENUM_SHAPED_TOKEN_RE = /\b[a-z]{2,}(?:_[a-z0-9]+)+\b/gi;
const URL_SPAN_RE = /https?:\/\/\S+/gi;

export function scrubInternalEnums(text) {
  if (!text || typeof text !== "string") return { text: text || "", changed: false };

  // Mask URLs so legitimate underscores in link targets are not touched.
  const urls = [];
  let masked = text.replace(URL_SPAN_RE, (u) => {
    urls.push(u);
    return ` URL${urls.length - 1} `;
  });

  // 1. Node ids are never customer-facing — remove outright.
  masked = masked.replace(INTERNAL_NODE_ID_RE, "");
  // 2. Known value tokens -> their friendly label (nicer than humanizing).
  masked = masked.replace(ORTHOTIC_ENUM_TOKEN_RE, (m) => friendlyEnumLabel(m));
  // 3. Any remaining enum-shaped token -> humanized, so no raw snake_case
  //    enum can ever reach the customer.
  masked = masked.replace(ENUM_SHAPED_TOKEN_RE, (m) => m.replace(/_/g, " "));

  let out = masked
    .replace(/ URL(\d+) /g, (_, i) => urls[Number(i)])
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
  return { text: out, changed: out !== text };
}

// =====================================================================
// Resolver fulfillment invariant (M1 stabilization)
// =====================================================================
//
// If the resolver returned action=recommend with non-empty
// candidate_products, the customer MUST see product cards. Empty-pool
// repair / "nothing's quite hitting" fallbacks must stand down when
// this predicate is true — those failure messages are wrong when the
// resolver already confirmed the catalog has matches.

export function resolverPromisedRecommendation(resolverState) {
  if (!resolverState || resolverState.type !== "resolver_state") return false;
  const action = resolverState.recommended_next_action?.type;
  if (action !== "recommend") return false;
  const candidates = resolverState.candidate_products;
  return Array.isArray(candidates) && candidates.length > 0;
}

// =====================================================================
// Suggested-follow-up answerability gate (code-owned, unit-tested)
// =====================================================================
//
// Follow-up "quick reply" chips are generated by an LLM. The bot must
// never SUGGEST a question it then can't ANSWER — that's the
// `chip-unanswerable` seam. This is the single, tested chokepoint that
// decides answerability from facts the code knows (did the subject appear
// in the reply? is the claim verifiable?), rather than trusting the
// generation prompt to behave.
const SUGG_SPEC_DEEPDIVE_RE = /\b(?:tell me more about|explain|how does .* work|what (?:is|are) the (?:[a-z]+\s+)?(?:technology|system|fabric|foam|material|tech)|details?\s+(?:on|about)\s+the)\b/i;
const SUGG_SPEC_MEASURE_RE = /\b(?:heel\s+height|stack\s+height|toe\s+drop|heel-to-toe\s+drop|stack|gradient|density|grade|weight\s+in\s+(?:oz|grams|g)|dimensions|cm\b|mm\b)\b/i;
const SUGG_TECH_NAME_RE = /(?:[™®]|\b[A-Z][A-Za-z]*(?:[A-Z][A-Za-z]+){1,}\b)/;
// Discount/loyalty MECHANICS the bot cannot verify (does GovX apply to a
// specific category? do codes stack?). Drop these — the bot can only point
// to the live offer, so suggesting the question sets up a non-answer.
const SUGG_DISCOUNT_MECHANICS_RE = /\b(?:govx|gov\s*x|discount|promo(?:tion)?|coupon|code|loyalty|rewards?|points?)\b/i;
const SUGG_MECHANICS_QUALIFIER_RE = /\b(?:categor|specific|which|each|certain|appl(?:y|ies|ied)|stack|combine|maximi[sz]e|best way)\b/i;

export function isUnanswerableSuggestion(question, { lastText = "" } = {}) {
  const q = String(question || "");
  if (!q.trim()) return { unanswerable: true, reason: "empty" };
  const lastLower = String(lastText || "").toLowerCase();

  // Spec deep-dive — allowed only if its subject already appeared in the reply.
  if (SUGG_SPEC_DEEPDIVE_RE.test(q)) {
    const subjectMatch = q.match(/\babout\s+(?:the\s+)?([A-Za-z][A-Za-z0-9™®\s-]{2,40})/i);
    const subj = subjectMatch ? subjectMatch[1].trim().toLowerCase() : "";
    if (!subj || !lastLower.includes(subj.replace(/[™®]/g, "").trim())) {
      return { unanswerable: true, reason: "spec-deepdive without prior mention" };
    }
  }
  // Branded / TitleCase tech name not present verbatim in the reply.
  const techMatches = q.match(new RegExp(SUGG_TECH_NAME_RE.source, "g")) || [];
  for (const term of techMatches) {
    const cleaned = term.replace(/[™®]/g, "").trim();
    if (cleaned.length < 4) continue;
    if (!lastLower.includes(cleaned.toLowerCase())) {
      return { unanswerable: true, reason: "branded tech term not in reply" };
    }
  }
  // Spec/measurement not quoted in the reply.
  if (SUGG_SPEC_MEASURE_RE.test(q) && !SUGG_SPEC_MEASURE_RE.test(lastText)) {
    return { unanswerable: true, reason: "spec measurement not in reply" };
  }
  // Discount/loyalty mechanics the bot cannot verify.
  if (SUGG_DISCOUNT_MECHANICS_RE.test(q) && SUGG_MECHANICS_QUALIFIER_RE.test(q)) {
    return { unanswerable: true, reason: "discount mechanics the bot can't verify" };
  }
  return { unanswerable: false, reason: "" };
}

// =====================================================================
// Smaller heuristics
// =====================================================================

// Open-ended customer query — "trip", "wedding", "what should I get"
// etc. Used to trigger auto-broaden when product search returned ≤ 2
// hits, so the customer sees a wider sample instead of a near-empty
// grid.
const BROAD_NEED_RE = /\b(trip|vacation|cruise|wedding|gift|present|going to|on my feet|all day|need shoes|need something|recommend|suggestion|what should|some advice|help me find|surprise me|something for)\b/i;

export function detectBroadNeed(text) {
  if (typeof text !== "string" || !text) return false;
  return BROAD_NEED_RE.test(text);
}

// AI denial phrasing — "we don't have X / we don't carry / no X
// available". Used (with detectAiPivotPhrasing as override) to decide
// whether to hide the card pool when the AI says no but cards are
// still attached.
//
// Widened to cover production phrasings that slipped through:
// "unfortunately,"/"sadly,"/"I'm afraid" prefixes, "can't find" /
// "couldn't find" / "couldn't locate", "no longer carry", and
// "currently unavailable / sold out".
const AI_NO_MATCH_RE = new RegExp(
  [
    "don'?t\\s+(?:have|see|carry|stock|find|appear)",
    "not\\s+(?:see|carry|have|find|available|in\\s+stock|carried)",
    "don'?t\\s+appear",
    "we\\s+don'?t",
    "no\\s+.{0,30}\\s+available",
    "unfortunately[,!]?\\s+(?:no|we|none|i|there|that|this)",
    "sadly[,!]?\\s+(?:no|we|none|i|there)",
    "i'?m\\s+afraid\\s+(?:we|i|that|there|this)",
    "can(?:no|'?)t\\s+(?:find|locate|see)",
    "couldn'?t\\s+(?:find|locate)",
    "wasn'?t\\s+able\\s+to\\s+find",
    "no\\s+longer\\s+(?:carry|stock|sell|available)",
    "currently\\s+(?:unavailable|sold\\s+out)",
    "sold\\s+out",
    "appears?\\s+(?:to\\s+be\\s+)?(?:no\\s+longer|sold\\s+out|unavailable)",
  ].map((p) => `(?:${p})`).join("|"),
  "i",
);

export function detectAiNoMatchPhrasing(text) {
  if (typeof text !== "string" || !text) return false;
  return AI_NO_MATCH_RE.test(text);
}

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z"'])/;

// Pool-aware denial lead-in stripper. When the pool has cards AND the
// AI opens with a denial sentence, the denial contradicts the cards
// beneath. Strip leading denial sentences only, preserving the rest.
export function stripDenialLeadIn(text, { poolSize = 0 } = {}) {
  if (!text || typeof text !== "string") return { text: text || "", changed: false };
  if (poolSize <= 0) return { text, changed: false };
  const sentences = text.split(SENTENCE_SPLIT_RE);
  if (sentences.length === 0) return { text, changed: false };
  let cursor = 0;
  while (cursor < sentences.length && AI_NO_MATCH_RE.test(sentences[cursor])) {
    cursor += 1;
  }
  if (cursor === 0) return { text, changed: false };
  const rest = sentences.slice(cursor).join(" ").trim();
  if (rest.length < 20) return { text, changed: false };
  return { text: rest, changed: true };
}

export function stripAvailabilityDenialSentences(text) {
  if (typeof text !== "string" || !text) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length <= 1) return text;
  const kept = sentences.filter((sentence) => !detectAiNoMatchPhrasing(sentence));
  if (kept.length === sentences.length) return text;
  const cleaned = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  return cleaned.length >= 20 ? cleaned : text;
}

// Clarifying-question detection — the AI's reply ends with a
// question mark, OR the last sentence is a question. Used to protect
// recommender elicitation turns from product-pitch repair (no pool +
// pitch text would otherwise trigger a fallback).
export function looksLikeClarifyingQuestion(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.endsWith("?")) return true;
  const lastChunk = trimmed.split(/[.!]\s+/).pop() || "";
  return /\?\s*$/.test(lastChunk.trim());
}

// =====================================================================
// Suggestion gender-contradiction filter
// =====================================================================
// Production scenario: customer says "find men's shoes" → bot
// suggests "Do you have these for women?" as a follow-up. The
// suggestion-generator prompt encourages "pivot to different
// gender" suggestions in general, but those make zero sense once
// the customer has explicitly committed to a gender. Drop them.

const OPPOSITE_GENDER_RE_FROM_MEN = /\b(?:women['‘’]?s|womens|women|female|lady|ladies|girls?)\b/i;
const OPPOSITE_GENDER_RE_FROM_WOMEN = /\b(?:men['‘’]?s|mens|men\b|male|guys?|boys?)\b/i;

export function suggestionContradictsGender(suggestion, establishedGender) {
  if (typeof suggestion !== "string" || !suggestion) return false;
  if (!establishedGender) return false;
  const g = String(establishedGender).toLowerCase();
  if (g === "men") return OPPOSITE_GENDER_RE_FROM_MEN.test(suggestion);
  if (g === "women") return OPPOSITE_GENDER_RE_FROM_WOMEN.test(suggestion);
  return false; // kids / unisex / unknown — no contradiction filter
}

// =====================================================================
// Footwear over-elicitation guard
// =====================================================================
// Decides whether to inject a turn-scoped force-search directive
// into the system prompt. Fires when the customer has both gender
// and category established for a footwear request, so the LLM
// shouldn't ask a third question. Returns a string directive or
// null.
//
// Match criteria — ALL must hold:
//   - classifier said footwear=true
//   - establishedGender is set (men/women/kids)
//   - latestUserMessage matches one of the catalog categories
//     (singular/plural normalized) — i.e. customer just clicked or
//     typed a category like "Sneakers"
//
// Returns: { gender, category, directive } or null.

export function detectFootwearOverElicitation({
  classifiedIntent,
  latestUserMessage,
  establishedGender,
  catalogProductTypes,
}) {
  if (!classifiedIntent || classifiedIntent.isFootwearRequest !== true) return null;
  if (!establishedGender) return null;
  const g = String(establishedGender).toLowerCase();
  if (g !== "men" && g !== "women" && g !== "kids") return null;
  const u = String(latestUserMessage || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!u || u.length < 3) return null;
  const uStem = u.replace(/s$/, "");
  const types = Array.isArray(catalogProductTypes) ? catalogProductTypes : [];
  // Path A — chip-click match: latest message EQUALS a catalog category
  // (after normalizing plural/whitespace). e.g. customer clicked
  // "Sneakers" chip → uStem="sneaker" matches category "Sneakers".
  let catMatch = types.find((cat) => {
    const c = String(cat || "")
      .toLowerCase()
      .replace(/s$/, "")
      .replace(/\s+/g, " ")
      .trim();
    return c.length >= 3 && c === uStem;
  });
  // Path B — free-text match: latest message CONTAINS a category
  // word as a whole-token substring. Production trace: customer says
  // "how about shoes for my dad" — gender=Men + footwear=true but
  // the message doesn't equal a category. We still want to force a
  // search this turn, not let the LLM ask a third question. Match
  // category words as whole tokens (escape category, word-boundary
  // both sides) and prefer the most specific match (longest first).
  if (!catMatch) {
    const sortedTypes = [...types].sort((a, b) => String(b).length - String(a).length);
    catMatch = sortedTypes.find((cat) => {
      const c = String(cat || "").toLowerCase().trim();
      if (c.length < 3) return false;
      // Build a regex that allows a trailing 's' on the catalog word
      // (sneaker → sneakers) and respects word boundaries.
      const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/s$/, "s?");
      try {
        return new RegExp(`\\b${escaped}\\b`, "i").test(u);
      } catch { return false; }
    });
    // Path C — generic "shoes / footwear" mention with gender. Even
    // without a specific category in the message, "shoes for my dad"
    // is a clear footwear intent — search the full footwear space.
    if (!catMatch && /\b(?:shoes?|footwear|kicks)\b/i.test(u)) {
      catMatch = "Footwear";
    }
  }
  if (!catMatch) return null;
  const cat = String(catMatch).toLowerCase();
  return {
    gender: g,
    category: cat,
    directive:
      `\n\n=== URGENT TURN-SCOPED DIRECTIVE — FOOTWEAR SEARCH ===\n` +
      `THIS TURN ONLY. The customer's gender (${g}) and category (${cat}) are BOTH established. ` +
      `Your FIRST action this turn MUST be search_products with gender="${g}" and ` +
      `filters.category="${cat}". Do NOT ask any clarifying question. Show product cards. ` +
      `If the search returns few results, that is fine — show what you have. ` +
      `Only AFTER you have called search_products and seen results may you write text.`,
  };
}
