// Per-turn intent resolver.
//
// One pure function. Given the customer's latest message, the
// previously-accumulated scope, the resolver/classifier output, and
// any chip-click event on this turn, decides what kind of turn this
// is and which stored scope keys (if any) the customer just
// invalidated.
//
// The point of this module is to replace the scattered stale-scope
// patches around the codebase (response-contract's
// `customerMentionsColorThisTurn`, session-memory's category-pivot
// detection, the meta/fact short-circuits) with a single debuggable
// decision. Consumers read `label` to know what shape the turn is;
// `staleKeysToDrop` says which scope keys must NOT be carried into
// this turn's resolver/listing/suggestion logic.
//
// Design rules (from the spec):
//   1. Chip clicks are durable intent. Never wipe chip-click facts
//      just because the text is short.
//   2. Multi-turn refinements must preserve scope.
//   3. Gender-only continuation must preserve category/color.
//   4. Explicit category pivots drop category-bound facts.
//   5. Color-only pivots replace color only.
//   6. Broad reset drops category-bound but keeps subject (gender).
//   7. Meta/fact questions keep scope but skip listing rewrites.
//   8. Orthotic flow has its own pivot logic — we don't fight it.
//   9. Resolver/classifier facts are signals, not truth.
//   10. Low confidence + scope-material decision → ambiguous (ask).
//
// The function is intentionally pure (no I/O, no DB) so it can be
// dropped into any caller and unit-tested deterministically.

import { extractUserConstraints } from "./catalog-resolver.server.js";

// ---------------------------------------------------------------------------
// Linguistic signals (regex catalogue)
// ---------------------------------------------------------------------------

// Hard pivot — customer is replacing their previous ask outright.
// "forget that, show me X", "instead of X, Y", "scrap the heels".
const HARD_PIVOT_RE =
  /\b(?:forget\s+(?:that|those|it|about)|never\s*mind|scrap\s+(?:that|those|the)|instead\s+of\b[^.!?]{0,40}\b(?:show|find|look|browse|do\s+you))/i;
const INSTEAD_PIVOT_RE = /\b(?:instead|rather\s+than)\b/i;
const RESET_THEN_SEARCH_RE =
  /\b(?:actually|wait\s*,?\s*|hmm\s*,?\s*|hold\s+on\s*,?\s*)\b[^.!?]{0,60}\b(?:show|find|look|search|recommend|do\s+you\s+have|got\s+any|any\s+(?:other|different))/i;

// Broad scope-reset phrasing. "any type of shoe", "doesn't matter",
// "show me everything", "what else". Drops category-bound scope but
// keeps subject (gender) — the customer's WIDENING within a subject,
// not abandoning it.
const BROAD_RESET_RE =
  /\b(?:any\s+(?:type|kind|sort|style)\s+of|all\s+(?:types|kinds|sorts|styles)|doesn'?t\s+matter|whatever\s+is|anything|everything(?:\s+you\s+(?:have|carry|sell))?|all\s+(?:of\s+)?your\s+\w+|all\s+your\s+stuff|show\s+me\s+(?:whatever|anything|everything|all)|what\s+else|something\s+else|other\s+(?:options|things|stuff))\b/i;

// Pronoun back-reference — "all of them", "any of those", "both of
// them". Looks like a broad reset but is actually referring to a set
// the assistant already showed. Treat as continue.
const PRONOUN_BACK_REF_RE = /\b(?:all|any|both)\s+of\s+(?:them|those|these|it)\b/i;

// Meta / fact-question shapes. Customer is asking a yes/no factual
// question or expressing frustration / calling out the bot. Don't
// touch scope; downstream listing template should not run.
const META_CONVERSATIONAL_RE =
  /\b(?:do\s+you\s+(?:even\s+|actually\s+)?(?:understand|get|hear|see|listen|know\s+what)|what\s+do\s+you\s+mean|what'?s\s+wrong|are\s+you\s+(?:serious|broken|kidding|joking|listening|paying\s+attention|okay|alright)|why\s+(?:are\s+you|did\s+you|aren'?t\s+you|do\s+you\s+keep)|that'?s\s+not\s+what|you'?re\s+not\s+(?:listening|understanding|getting)|i\s+(?:just|already)\s+(?:said|told|asked))\b/i;
const YES_NO_INVERTED_RE =
  /^\s*(?:so\s+|wait\s*,?\s*|actually\s*,?\s*|hmm\s*,?\s*|hey\s*,?\s*)?(?:is|are|isn'?t|aren'?t|does|do|doesn'?t|don'?t|will|won'?t|can|can'?t|did|didn'?t|was|wasn'?t|were|weren'?t)\s+[A-Za-z][\w'-]{1,30}\b[^?]{0,120}\?\s*$/i;
const YES_NO_NON_INVERTED_RE =
  /^\s*(?:so\s+|wait\s*,?\s*|actually\s*,?\s*|hmm\s*,?\s*|hey\s*,?\s*)?[A-Za-z][\w'-]{1,30}\s+(?:is|are|isn'?t|aren'?t|was|wasn'?t|were|weren'?t|will\s+be|won'?t\s+be)\s+[^?]{0,120}\?\s*$/i;
// Compare-request vocabulary. Single source of truth — also
// imported by chat-postprocessing's detectSingularIntent so the
// codebase has ONE definition of "this turn is a comparison".
// Covers explicit compare verbs (compare/comparison), shorthand
// (vs/versus/side-by-side), "which is better / which one is better",
// "difference between" / "between X and Y", and back-references to
// shown cards ("the first two / the top two").
export const COMPARE_RE =
  /\b(?:compare|comparison|vs\.?|versus|difference\s+between|better\s+between|between\s+[a-z0-9'-]+\s+(?:and|or)\s+[a-z0-9'-]+|which\s+(?:is|one\s+is)\s+(?:better|worse)|side[- ]by[- ]side|tell\s+me\s+the\s+difference|the\s+(?:first|top)\s+two|which\s+(?:is|one|of))\b/i;

// Refinement vocabulary — customer is narrowing the existing ask
// rather than starting over.
const REFINE_PRICE_RE = /\b(?:cheaper|less\s+expensive|cheapest|under\s+\$?\d+|below\s+\$?\d+|on\s+sale)\b/i;
const REFINE_SIZE_WIDTH_RE = /\b(?:size\s+\d|width|wider|narrower|wide|narrow|extra[\s-]wide|d\s+width)\b/i;
const REFINE_GENERIC_RE = /\b(?:show\s+more|more\s+like|similar|something\s+like|any\s+others?|other\s+(?:options|styles|choices))\b/i;

// Pronouns indicating reference to the displayed set / last shown
// product. Strong "continue" signal.
const PRONOUN_REFERENCE_RE = /\b(?:these|those|them|it|this\s+one|that\s+one|the\s+first|the\s+second|the\s+last|the\s+top|the\s+one)\b/i;

// Bare color vocabulary — used to spot color-only pivots.
const COLOR_LEX_RE =
  /\b(?:red|blue|black|white|pink|navy|tan|brown|gray|grey|beige|olive|cream|nude|gold|silver|bronze|burgundy|cognac|charcoal|ivory|metallic|mocha|taupe|eggplant|purple|orange|yellow|green|rose|wine)\b/i;
const COLOR_VOCAB_RE =
  /\b(?:colou?rs?|colorways?|shades?|red|blue|black|white|pink|navy|tan|brown|gray|grey|beige|olive|cream|nude|gold|silver|bronze|burgundy|cognac|charcoal|ivory|metallic|mocha|taupe|eggplant|purple|orange|yellow|green|rose|wine)\b/i;

// Gender-only follow-up. "How about mens?" should NOT clear the
// category/color the customer just established — it means "same
// thing, other gender". Mirrors the existing helper in session-
// memory; kept independent here so this module is self-contained.
const GENDER_ONLY_CONTINUATION_RE =
  /^\s*(?:how|what|and|or|any)\s*(?:about|for)?\s+(?:the\s+)?(?:men|mens|men['’]?s|women|womens|women['’]?s|male|female|boys?|girls?|kids?|children)\??\s*$/i;

// Short conversational acknowledgments — "yes", "ok", "sure",
// "thanks", "go on", "next". These continue the prior context.
const SHORT_ACK_RE = /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|alright|cool|got\s+it|next|go\s+on|continue|thanks|thank\s+you|ty|please|please\s+do|sounds\s+good|that\s+works|nice|great|perfect)\s*[.!?]*\s*$/i;

// ---------------------------------------------------------------------------
// Outputs / decision shape
// ---------------------------------------------------------------------------

const LABEL = Object.freeze({
  PIVOT_FULL: "pivot_full",
  PIVOT_CATEGORY: "pivot_category",
  PIVOT_COLOR: "pivot_color",
  REFINE: "refine",
  CONTINUE: "continue",
  META: "meta",
  AMBIGUOUS: "ambiguous",
});

// Keys that belong to "the current category bucket" — if the
// category changes, these are stale. `condition` is here too: a
// clinical condition was named relative to the prior category
// (e.g. "plantar fasciitis sneakers" → category=sneakers,
// condition=plantar_fasciitis), so when the customer pivots to a
// new category the condition pairing is no longer guaranteed.
const CATEGORY_BOUND_KEYS = [
  "color", "size", "width", "condition", "useCase", "arch", "overpronation", "specificProduct",
];

// Keys that belong to "the current subject (gender)" — if the
// shopping subject changes outside a gender-only continuation,
// these are stale.
const SUBJECT_BOUND_KEYS = [
  "category", "color", "size", "width",
  "condition", "useCase", "arch", "overpronation", "specificProduct",
];

// Use-cases that are physically incompatible with certain
// categories. When a new turn names a use-case in this map AND the
// carried category is in its conflict set, the customer's need has
// changed — the old category and its bound facts must NOT ride
// along. Kept tight: only clear contradictions, so normal
// refinements ("sneakers" + "for running") are untouched.
const ATHLETIC_INCOMPATIBLE_CATEGORIES = [
  "sandals", "wedges-heels", "slippers", "mary-janes",
  "loafers", "oxfords", "clogs",
];
const USECASE_CATEGORY_CONFLICTS = {
  hiking: new Set(ATHLETIC_INCOMPATIBLE_CATEGORIES),
  running: new Set(ATHLETIC_INCOMPATIBLE_CATEGORIES),
  athletic: new Set(ATHLETIC_INCOMPATIBLE_CATEGORIES),
  dress: new Set(["sneakers", "slippers", "clogs", "slip-ons"]),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normStr(v) {
  return v == null ? null : String(v).toLowerCase().trim() || null;
}

function isNonEmpty(obj) {
  if (!obj) return false;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "string" && !v) continue;
    return true;
  }
  return false;
}

// Did the choice-events array tell us this turn was a chip click?
// Chip clicks are the most durable kind of intent — we never wipe
// them based on the text being terse. Returns the set of keys the
// chip(s) bound on this turn.
function chipClickKeysThisTurn(choiceEvents, turnIndex) {
  if (!Array.isArray(choiceEvents) || choiceEvents.length === 0) return new Set();
  const keys = new Set();
  for (const ev of choiceEvents) {
    if (!ev || ev.type !== "chip_answer") continue;
    if (turnIndex != null && ev.userTurnIndex !== turnIndex) continue;
    if (ev.fact && ev.fact.key) keys.add(ev.fact.key);
  }
  return keys;
}

// Catalog grounding — does the post-pivot scope point to anything
// real? Used to demote pivot confidence when the resulting scope
// wouldn't surface any product. The caller can pass an optional
// `catalogProbe(scope) → boolean` callback; when not given, the
// check is skipped (confidence stays as-is).
function pivotProducesValidScope({ proposedScope, catalogProbe }) {
  if (typeof catalogProbe !== "function") return null;
  try {
    return Boolean(catalogProbe(proposedScope));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The function
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TurnIntent
 * @property {"pivot_full"|"pivot_category"|"pivot_color"|"refine"|"continue"|"meta"|"ambiguous"} label
 * @property {number} confidence  0..1
 * @property {string} reason      Human-readable signal that fired.
 * @property {string[]} staleKeysToDrop  Scope keys the caller should drop.
 */

/**
 * Decide what kind of turn this is and which stored scope keys are
 * now stale. Pure function — no I/O.
 *
 * @param {Object} args
 * @param {string} args.latestUserText           The user's message this turn.
 * @param {Object} [args.previousScope]          Accumulated scope BEFORE this turn (memory.explicit).
 * @param {Object} [args.extractedUserConstraints] Output of `extractUserConstraints(latestUserText)`. If omitted, computed.
 * @param {Array}  [args.choiceEvents]           Chip/short-answer events from the choice-events parser.
 * @param {number} [args.turnIndex]              Which userTurnIndex this is (for matching chip events). Optional.
 * @param {Object} [args.classifiedIntent]       Classifier output. Optional. Used as tiebreaker only.
 * @param {Object} [args.resolverState]          Resolver state. Optional. Used as tiebreaker only.
 * @param {Function} [args.catalogProbe]         (scope) → boolean. True if catalog has at least one match. Optional.
 * @returns {TurnIntent}
 */
export function resolveTurnIntent({
  latestUserText = "",
  previousScope = {},
  extractedUserConstraints = null,
  choiceEvents = null,
  turnIndex = null,
  classifiedIntent = null,
  resolverState = null,
  catalogProbe = null,
} = {}) {
  const text = String(latestUserText || "").trim();
  const prev = previousScope || {};
  const extracted = extractedUserConstraints ?? extractUserConstraints(text) ?? {};
  const chipKeys = chipClickKeysThisTurn(choiceEvents, turnIndex);
  const hadChipClick = chipKeys.size > 0;

  // -----------------------------------------------------------------------
  // 1. Chip click — durable intent, never wipe based on short text.
  //    The chip already established a fact; this turn is at most a
  //    refine-on-top. Don't drop anything.
  // -----------------------------------------------------------------------
  if (hadChipClick) {
    return {
      label: LABEL.CONTINUE,
      confidence: 1.0,
      reason: `chip_click:${[...chipKeys].join(",")}`,
      staleKeysToDrop: [],
    };
  }

  // -----------------------------------------------------------------------
  // 2. Empty / whitespace-only — nothing to decide.
  // -----------------------------------------------------------------------
  if (!text) {
    return {
      label: LABEL.CONTINUE,
      confidence: 0.9,
      reason: "empty_text",
      staleKeysToDrop: [],
    };
  }

  // -----------------------------------------------------------------------
  // 3. Meta / fact-question — short-circuit. Scope stays; the caller's
  //    listing/contract logic should NOT force a product-list rewrite.
  // -----------------------------------------------------------------------
  if (META_CONVERSATIONAL_RE.test(text) || COMPARE_RE.test(text)) {
    return {
      label: LABEL.META,
      confidence: 0.9,
      reason: META_CONVERSATIONAL_RE.test(text) ? "meta_conversational" : "compare_request",
      staleKeysToDrop: [],
    };
  }
  if (YES_NO_INVERTED_RE.test(text) || YES_NO_NON_INVERTED_RE.test(text)) {
    // Yes/no question — meta UNLESS the customer also named a NEW
    // search constraint (color/category) that should advance scope.
    const namesNewSearchTerm =
      (extracted.category && extracted.category !== normStr(prev.category)) ||
      (extracted.color && extracted.color !== normStr(prev.color));
    if (!namesNewSearchTerm) {
      return {
        label: LABEL.META,
        confidence: 0.85,
        reason: "yes_no_fact_question",
        staleKeysToDrop: [],
      };
    }
  }

  // -----------------------------------------------------------------------
  // 4. Hard pivot ("forget that, show me X", "instead, show Y").
  //    Full reset of category-bound scope; keep gender unless the
  //    text also names a new gender (rule 3 vs 8: subject persists
  //    across hard pivots unless explicitly changed).
  // -----------------------------------------------------------------------
  if (HARD_PIVOT_RE.test(text) || INSTEAD_PIVOT_RE.test(text) || RESET_THEN_SEARCH_RE.test(text)) {
    const drop = SUBJECT_BOUND_KEYS.filter((k) => prev[k] != null);
    return {
      label: LABEL.PIVOT_FULL,
      confidence: 0.95,
      reason: HARD_PIVOT_RE.test(text)
        ? "hard_pivot_keyword"
        : RESET_THEN_SEARCH_RE.test(text)
          ? "reset_then_search"
          : "instead_keyword",
      staleKeysToDrop: drop,
    };
  }

  // -----------------------------------------------------------------------
  // 5. Broad reset ("any type of shoe", "show me everything", "what
  //    else"). Pronoun back-references ("all of them", "any of those")
  //    are NOT a reset — they reference a previously-shown set.
  //    Drops category-bound scope, keeps gender. The customer is
  //    widening within a subject.
  // -----------------------------------------------------------------------
  if (BROAD_RESET_RE.test(text) && !PRONOUN_BACK_REF_RE.test(text)) {
    const drop = ["category", ...CATEGORY_BOUND_KEYS].filter((k) => prev[k] != null);
    return {
      label: LABEL.PIVOT_FULL,
      confidence: 0.9,
      reason: "broad_reset",
      staleKeysToDrop: drop,
    };
  }

  // -----------------------------------------------------------------------
  // 6. Gender-only continuation ("how about mens?"). Carry category
  //    and color through; only gender changes. Requires extracted
  //    gender and no other category-bound facts extracted (otherwise
  //    it's not "gender-only").
  // -----------------------------------------------------------------------
  const prevGender = normStr(prev.gender);
  const newGender = normStr(extracted.gender);
  if (
    GENDER_ONLY_CONTINUATION_RE.test(text) &&
    newGender &&
    !extracted.category &&
    !extracted.color &&
    !extracted.size &&
    !extracted.width
  ) {
    return {
      label: LABEL.CONTINUE,
      confidence: 0.9,
      reason: "gender_only_continuation",
      staleKeysToDrop: [],
    };
  }

  // -----------------------------------------------------------------------
  // 7. Gender pivot (not gender-only continuation). The customer
  //    named a new gender after one was already established. Drop
  //    subject-bound scope (category, color, size, condition, etc.).
  // -----------------------------------------------------------------------
  if (newGender && prevGender && newGender !== prevGender) {
    const drop = SUBJECT_BOUND_KEYS.filter((k) => prev[k] != null);
    return {
      label: LABEL.PIVOT_FULL,
      confidence: 0.85,
      reason: "gender_pivot",
      staleKeysToDrop: drop,
    };
  }

  // -----------------------------------------------------------------------
  // 8. Use-case conflict with carried category. Customer named an
  //    activity/occasion incompatible with the current category but
  //    did NOT name a new category this turn ("hiking" while
  //    category=sandals). Treat as implicit category pivot.
  // -----------------------------------------------------------------------
  const prevCategory = normStr(prev.category);
  const newCategory = normStr(extracted.category);
  const newUseCase = normStr(extracted.useCase);
  if (
    !newCategory &&
    newUseCase &&
    prevCategory &&
    USECASE_CATEGORY_CONFLICTS[newUseCase]?.has(prevCategory)
  ) {
    const drop = ["category", ...CATEGORY_BOUND_KEYS].filter((k) => prev[k] != null);
    return {
      label: LABEL.PIVOT_FULL,
      confidence: 0.85,
      reason: "usecase_category_conflict",
      staleKeysToDrop: drop,
    };
  }

  // -----------------------------------------------------------------------
  // 9. Category pivot: customer named a category that differs from
  //    the carried one. Drop category-bound facts.
  // -----------------------------------------------------------------------
  if (newCategory && prevCategory && newCategory !== prevCategory) {
    const proposed = { ...prev, category: newCategory };
    for (const k of CATEGORY_BOUND_KEYS) delete proposed[k];
    const valid = pivotProducesValidScope({ proposedScope: proposed, catalogProbe });
    const drop = CATEGORY_BOUND_KEYS.filter((k) => prev[k] != null);
    return {
      label: LABEL.PIVOT_CATEGORY,
      // Demote when the new category doesn't appear to exist in
      // catalog (caller didn't probe = null = no demotion).
      confidence: valid === false ? 0.55 : 0.9,
      reason: valid === false ? "category_pivot_unverified" : "category_pivot",
      staleKeysToDrop: drop,
    };
  }

  // -----------------------------------------------------------------------
  // 9b. Category first mention — customer named a category and there
  //     was none before. Refine on top of existing subject scope.
  //     No drops (there's no prior category-bound scope to invalidate).
  // -----------------------------------------------------------------------
  if (newCategory && !prevCategory) {
    return {
      label: LABEL.REFINE,
      confidence: 0.9,
      reason: "category_first_mention",
      staleKeysToDrop: [],
    };
  }

  // -----------------------------------------------------------------------
  // 8. Color pivot: customer named a color that differs from the
  //    carried one (no category change). Drop just `color`.
  // -----------------------------------------------------------------------
  const prevColor = normStr(prev.color);
  const newColor = normStr(extracted.color);
  if (newColor && prevColor && newColor !== prevColor && !newCategory) {
    return {
      label: LABEL.PIVOT_COLOR,
      confidence: 0.9,
      reason: "color_pivot",
      staleKeysToDrop: ["color"],
    };
  }
  // Color-only first mention (prev had no color) — refine.
  if (newColor && !prevColor) {
    return {
      label: LABEL.REFINE,
      confidence: 0.9,
      reason: "color_refine_first_mention",
      staleKeysToDrop: [],
    };
  }

  // -----------------------------------------------------------------------
  // 9. Refinement vocabulary — narrows the current scope, doesn't
  //    replace it. price/size/width filters, "show more like these".
  // -----------------------------------------------------------------------
  if (REFINE_PRICE_RE.test(text) || REFINE_SIZE_WIDTH_RE.test(text) || REFINE_GENERIC_RE.test(text)) {
    return {
      label: LABEL.REFINE,
      confidence: 0.9,
      reason: REFINE_PRICE_RE.test(text)
        ? "refine_price"
        : REFINE_SIZE_WIDTH_RE.test(text)
          ? "refine_size_width"
          : "refine_more_like",
      staleKeysToDrop: [],
    };
  }

  // -----------------------------------------------------------------------
  // 10. Pronoun reference / short ack — continue.
  // -----------------------------------------------------------------------
  if (PRONOUN_REFERENCE_RE.test(text) || SHORT_ACK_RE.test(text)) {
    return {
      label: LABEL.CONTINUE,
      confidence: 0.85,
      reason: SHORT_ACK_RE.test(text) ? "short_ack" : "pronoun_reference",
      staleKeysToDrop: [],
    };
  }

  // -----------------------------------------------------------------------
  // 11. Tiebreaker — does the customer's text mention current scope?
  //     If they restate something already in scope, it's continue.
  // -----------------------------------------------------------------------
  if (prevColor && new RegExp(`\\b${prevColor}\\b`, "i").test(text)) {
    return {
      label: LABEL.CONTINUE,
      confidence: 0.7,
      reason: "restated_color",
      staleKeysToDrop: [],
    };
  }
  if (prevCategory && new RegExp(`\\b${prevCategory}\\b`, "i").test(text)) {
    return {
      label: LABEL.CONTINUE,
      confidence: 0.7,
      reason: "restated_category",
      staleKeysToDrop: [],
    };
  }

  // -----------------------------------------------------------------------
  // 12. Default: no clear signal. Use the classifier label as a
  //     soft tiebreaker; otherwise mark ambiguous so callers can
  //     decide to ask. Only worth asking when the existing scope is
  //     non-empty (otherwise there's nothing to lose either way).
  // -----------------------------------------------------------------------
  const scopeNonEmpty = isNonEmpty(prev);
  if (classifiedIntent?.attributes) {
    const a = classifiedIntent.attributes;
    if (a.category && normStr(a.category) !== prevCategory && prevCategory) {
      return {
        label: LABEL.PIVOT_CATEGORY,
        confidence: 0.6,
        reason: "classifier_category_diff",
        staleKeysToDrop: CATEGORY_BOUND_KEYS.filter((k) => prev[k] != null),
      };
    }
  }
  if (scopeNonEmpty) {
    return {
      label: LABEL.AMBIGUOUS,
      confidence: 0.4,
      reason: "no_clear_signal_scope_nonempty",
      staleKeysToDrop: [],
    };
  }
  return {
    label: LABEL.CONTINUE,
    confidence: 0.6,
    reason: "no_clear_signal_no_prior_scope",
    staleKeysToDrop: [],
  };
}

export const TurnIntentLabels = LABEL;
