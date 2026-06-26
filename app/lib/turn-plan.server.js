// =====================================================================
// TurnPlan — the single front-of-turn brain.
// =====================================================================
import { isCompatibilityAsk, isMultiRecommendationAsk } from "./constraint-plan.js";
//
// Deterministically classifies a customer turn into ONE workflow and emits
// a plan that governs the whole turn: what evidence is required, whether a
// search must run, whether the model may ask a clarifying question, how
// products should be displayed, and what shape the answer must take.
//
// This replaces the scattered per-screenshot rules (occasion remaps, gender
// gates, "should I suppress cards", "force a lookup") with one place that
// decides. The plan is injected into the system prompt so the LLM-owns-turn
// model follows it, and a few high-value fields drive deterministic hooks
// (gender default, card display). It is a PURE function — no Prisma, no IO —
// so it is fully unit-testable; the caller passes in the signals it needs.
//
// Workflows (precedence order, first match wins):
//   1. policy_account       — returns/refunds/shipping/order/account
//   2. availability         — size/color/stock for a known/named product
//   3. comparison           — "X vs Y", "which is better"
//   4. named_product_advisory — named product + worth/suitability/condition
//   5. condition_recommendation — condition/use-case (± category) "what do you recommend"
//   6. browse               — "show me X", plain product search
//   7. clarification        — genuinely ambiguous / no actionable signal

export const WORKFLOWS = {
  POLICY_ACCOUNT: "policy_account",
  AVAILABILITY: "availability",
  COMPARISON: "comparison",
  NAMED_PRODUCT_ADVISORY: "named_product_advisory",
  CONDITION_RECOMMENDATION: "condition_recommendation",
  MULTI_RECOMMENDATION: "multi_recommendation",
  COMPATIBILITY: "compatibility",
  SALE_BROWSE: "sale_browse",
  SIZING_HELP: "sizing_help",
  BROWSE: "browse",
  CLARIFICATION: "clarification",
};

const POLICY_RE =
  /\b(return|returns|refund|exchange(?:s|d)?|warranty|guarantee|ship(?:ping|ped)?|delivery|deliver|track(?:ing)?|order\s+status|my\s+order|where\s+is\s+my|cancel(?:lation)?|account|sign\s+in|log\s+in|password|invoice|receipt)\b/i;

// Promo / discount MECHANICS — code eligibility, special discounts, stacking.
// These are answered from policy/promotion knowledge, NOT a product search.
// (Shopping a sale — "what's on sale" — is SALE_BROWSE, handled separately.)
const PROMO_POLICY_RE = new RegExp(
  "\\b(?:promo|discount|coupon|voucher)\\s*code[s]?\\b" + "|" +
  "\\bcode[s]?\\s+(?:for|to\\s+use|work)\\b" + "|" +
  "\\b(?:military|veteran|teacher|student|nurse|first[-\\s]?responder|senior|healthcare)\\s+discount\\b" + "|" +
  "\\b(?:stack|combine|apply)\\s+(?:a\\s+)?(?:discount|code|coupon|promo)s?\\b" + "|" +
  "\\bdo\\s+you\\s+(?:have|offer)\\s+(?:a\\s+)?(?:promo|discount|coupon)\\b",
  "i",
);

// Shopping a SALE — the customer wants to SEE discounted products. This is a
// commerce turn (search onSale), never a support/policy punt.
const SALE_BROWSE_RE = new RegExp(
  "\\bon\\s+sale\\b|\\bwhat'?s\\s+on\\s+sale\\b|\\bcurrent\\s+(?:sale|promotion|deal)s?\\b" + "|" +
  "\\b(?:show|see|browse|find|any|got)\\b[^.?!\\n]{0,30}\\b(?:sale[s]?|deal[s]?|discount(?:ed)?|clearance|markdown[s]?|promotion[s]?|specials?)\\b" + "|" +
  "\\b(?:sale|discount(?:ed)?|clearance|markdown[s]?)\\s+(?:item|style|product|shoe|sandal|sneaker|boot|wedge|flat|heel)s?\\b" + "|" +
  "\\bclearance\\b|\\bmarkdown[s]?\\b|\\bwhat\\s+deals\\b|\\bany\\s+deals\\b|\\bon\\s+clearance\\b",
  "i",
);

// Sizing / fit ADVICE — "what size should I get", not "what sizes are in stock".
// The (?:should|do|would|am)\s+i / to\s+(get|buy…) subject distinguishes a fit
// question from an availability question ("what sizes do you have").
const SIZING_HELP_RE = new RegExp(
  "\\b(?:what|which)\\s+size\\s+(?:should\\s+i|do\\s+i|would\\s+i|am\\s+i|to\\s+(?:get|buy|order|wear|pick|choose))\\b" + "|" +
  "\\bhelp\\s+(?:me\\s+)?(?:choos(?:e|ing)|pick(?:ing)?|find(?:ing)?)[^.?!\\n]{0,20}\\bsize\\b" + "|" +
  "\\b(?:choos(?:e|ing)|pick(?:ing)?|find(?:ing)?)\\s+(?:the\\s+)?(?:right\\s+|correct\\s+|my\\s+)?size\\b" + "|" +
  "\\bhow\\s+do\\s+i\\s+know\\s+my\\b[^.?!\\n]{0,20}\\bsize\\b" + "|" +
  "\\bwhat'?s\\s+my\\b[^.?!\\n]{0,15}\\bsize\\b" + "|" +
  "\\b(?:run[s]?\\s+true\\s+to\\s+size|true\\s+to\\s+size|run[s]?\\s+(?:small|large|big))\\b" + "|" +
  "\\bsize\\s+recommendation\\b|\\bhelp\\s+(?:me\\s+)?with\\s+(?:my\\s+)?siz(?:e|ing)\\b",
  "i",
);

// Size / color / stock — the availability shape. ("what colors" is included
// here too; it's a variant-data question, answered from the product.)
const SIZE_COLOR_STOCK_RE = new RegExp(
  "\\bsize\\s*\\d+(?:\\.5)?\\b" + "|" +
  "\\bwhat\\s+size\\b|\\bwhich\\s+size\\b|\\bsize\\s+(?:should|do|would)\\b" + "|" +
  "\\b(?:in|out\\s+of|back\\s+in)\\s+stock\\b|\\bsold\\s+out\\b|\\bavailable\\b|\\bavailability\\b" + "|" +
  "\\bdo\\s+you\\s+(?:have|carry|sell)\\b[^.?!\\n]{0,40}\\b(?:in|size)\\b" + "|" +
  "\\bcome[s]?\\s+in\\b|\\bwhat\\s+colou?rs?\\b|\\bwhich\\s+colou?rs?\\b|\\bcolou?rs?\\s+(?:does|do|are)\\b",
  "i",
);

// Deictic color/size FOLLOW-UP after a product is already in context ("and in
// black?", "in a 9?", "how about wide?"). These name no product and carry no
// "size"/"stock" keyword, so SIZE_COLOR_STOCK_RE misses them — yet they clearly
// continue an availability thread. Gated to SHORT messages (≤5 words) WITH
// product context so it never steals a longer advisory ("is the Jillian good in
// black?") or a plain browse ("show me shoes in black").
const FOLLOWUP_AVAIL_RE = new RegExp(
  "\\b(?:and\\s+)?(?:in|how\\s+about|what\\s+about)\\s+(?:an?\\s+|it\\s+in\\s+|the\\s+)?(?:" +
  "black|white|ivory|cream|navy|blue|red|burgundy|wine|maroon|pink|blush|rose|fuchsia|coral|" +
  "green|olive|sage|tan|beige|nude|taupe|khaki|brown|chocolate|cognac|camel|bronze|copper|gold|" +
  "silver|pewter|grey|gray|charcoal|slate|champagne|mauve|lavender|purple|plum|yellow|mustard|orange|" +
  "wide|narrow|\\d{1,2}(?:\\.5)?)\\b",
  "i",
);

const COMPARISON_RE =
  /\b(?:vs\.?|versus|compare[ds]?|comparison|which\s+is\s+better|better\s+(?:for|than)|difference\s+between|which\s+(?:one\s+)?should\s+i)\b/i;

// Advisory / value / suitability about a (usually named) product.
const ADVISORY_RE = new RegExp(
  "\\bworth\\b|\\bhold[s]?\\s+up\\b|\\bgood\\s+(?:for|enough)\\b|\\bdurable\\b" + "|" +
  "\\bis\\s+(?:it|this|that|the|these|they)\\b[^.?!\\n]{0,40}\\b(?:good|worth|suitable|right|casual|active|comfortable)\\b" + "|" +
  "\\bmore\\s+of\\s+a\\b|\\bshould\\s+i\\s+(?:buy|order|get)\\b",
  "i",
);

// Medical CONDITIONS only — "arch support" is a feature/filter, not a
// condition, so it is deliberately excluded (otherwise "show me sandals
// with arch support" misclassifies as a clinical recommendation).
const CONDITION_RE =
  /\b(plantar|fasciitis|bunion|bunions|neuroma|metatarsal|metatarsalgia|overpronat\w*|supinat\w*|sesamoid|capsulitis|fallen\s+arch\w*|flat\s+feet|heel\s+(?:pain|spur)|arch\s+pain|achilles|neuropathy|diabetic|foot\s+pain|ball\s+of\s+foot)\b/i;

const USECASE_RE =
  /\b(walking|standing|all[-\s]?day|on\s+my\s+feet|vacation|travel|trip|hiking|running|gym|workout|wedding|work|nurse|nursing|teacher|tourism|sightseeing|theme\s+park|disney|cruise)\b/i;

const BROWSE_RE =
  /\b(show\s+me|do\s+you\s+(?:have|carry|sell)|looking\s+for|i\s+(?:want|need)\b|browse|what\s+(?:sandals?|shoes?|footwear|boots?|sneakers?|clogs?|loafers?|slippers?|heels?|wedges?)\s+(?:do\s+you|are)|under\s+\$?\d+|recommend)\b/i;

const RECOMMEND_RE =
  /\b(what\s+(?:would|do)\s+you\s+recommend|what\s+should\s+i\s+(?:get|buy|wear)|help\s+me\s+(?:find|pick|choose)|need\s+(?:a\s+)?(?:sandal|shoe|footwear|sneaker|boot|something))\b/i;

// Gender signals, split by direction so the plan can RESOLVE men/women,
// not merely detect "some gender was mentioned". Recipient nouns and
// pronouns count: "my husband / dad / son / his" → men; "my wife / mom /
// daughter / her" → women.
const MALE_RE =
  /\b(men'?s?|male|man|guy|boy|husband|boyfriend|dad|daddy|father|son|grandpa|grandfather|he|him|his)\b/i;
const FEMALE_RE =
  /\b(women'?s?|female|woman|lady|girl|wife|girlfriend|mom|mommy|mother|daughter|grandma|grandmother|she|her|hers)\b/i;

// Resolve a concrete gender ("men" | "women" | null) from the classifier
// attrs first (authoritative when present), then the message. A message
// that names BOTH sides ("for my husband and my wife") is ambiguous → null,
// so the caller falls back to the primary line where a default is allowed.
function resolveStatedGender(m, attrs) {
  const a = String(attrs?.gender || "").toLowerCase();
  if (a === "men" || a === "man" || a === "male") return "men";
  if (a === "women" || a === "woman" || a === "female") return "women";
  const male = MALE_RE.test(m);
  const female = FEMALE_RE.test(m);
  if (male && !female) return "men";
  if (female && !male) return "women";
  return null; // none, or conflicting
}

function words(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}

// answerRequirements is advisory shape only — quality (length/answer-first)
// is enforced as metrics/log warnings, NOT live blockers, per the contract.
function reqs({ answerFirst = false, concise = false, answerInText = false, recommendOne = false, honestTradeoff = false } = {}) {
  return { answerFirst, concise, answerInText, recommendOne, honestTradeoff };
}

/**
 * planTurn — pure deterministic turn classifier.
 *
 * @param {object} input
 * @param {string} input.message        latest customer message
 * @param {object} [input.attrs]        classifier attrs { gender, useCase, condition }
 * @param {boolean} [input.namedProduct] a catalog product FAMILY is named in the message
 * @param {string|null} [input.focusProduct] anchored product handle/title from a prior turn
 * @param {boolean} [input.hasPriorCards] cards were shown on a previous turn
 * @param {string} [input.primaryGender] merchant's primary line (default "women")
 * @returns {object} plan
 */
export function planTurn({
  message = "",
  attrs = {},
  namedProduct = false,
  focusProduct = null,
  hasPriorCards = false,
  primaryGender = "women",
} = {}) {
  const m = String(message || "");
  const hasNamed = Boolean(namedProduct);
  const hasProductContext = hasNamed || Boolean(focusProduct);
  const condition = Boolean(attrs?.condition) || CONDITION_RE.test(m);
  const useCase = Boolean(attrs?.useCase) || USECASE_RE.test(m);

  // Resolved gender direction ("men"|"women"|null) and whether the customer
  // stated one at all. `genderFor` applies the default rule per workflow:
  // a stated gender always wins; otherwise default to the primary line only
  // where a default is allowed (advisory/condition/comparison-on-condition).
  const statedGender = resolveStatedGender(m, attrs);
  const genderFor = (allowDefault) => statedGender || (allowDefault ? primaryGender : null);

  // 1. Policy / order / account — never a product turn.
  if (POLICY_RE.test(m)) {
    return finalize({
      workflow: WORKFLOWS.POLICY_ACCOUNT,
      requiredEvidence: ["policy_or_order_data"],
      searchRequired: false,
      clarificationAllowed: false,
      productDisplayPolicy: "suppress",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: null,
      directives: [
        "Answer the policy/order/account question directly from knowledge or order data. Do NOT search the catalog or show product cards.",
      ],
    });
  }

  // 1b. Promo / discount MECHANICS (codes, military/teacher discount, stacking)
  // → answered from policy/promotion knowledge, never a product search. Checked
  // before SALE_BROWSE so "do you have a promo code?" doesn't trigger a search.
  if (PROMO_POLICY_RE.test(m)) {
    return finalize({
      workflow: WORKFLOWS.POLICY_ACCOUNT,
      requiredEvidence: ["policy_or_order_data"],
      searchRequired: false,
      clarificationAllowed: false,
      productDisplayPolicy: "suppress",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: null,
      directives: [
        "Answer the promo/discount-code question from active promotion knowledge or policy docs. If no active code exists, say codes are verified at checkout. Do NOT search the catalog or show product cards unless the customer ALSO explicitly asked to shop sale items.",
      ],
    });
  }

  // 1c. Sizing / fit ADVICE. Generic ("what size should I get?") with NO product
  // context is a clarification — must NOT search or show cards. WITH a product in
  // context (named or focus), it's a sizing question about THAT product — search
  // and focus it, answer from its fit/variant/review data. Placed before
  // availability so "what size should I get in Jillian" routes to advice, not a
  // stock check.
  if (SIZING_HELP_RE.test(m)) {
    if (hasProductContext) {
      return finalize({
        workflow: WORKFLOWS.NAMED_PRODUCT_ADVISORY,
        requiredEvidence: ["product_facts"],
        searchRequired: true,
        clarificationAllowed: false,
        productDisplayPolicy: "show_focused",
        answerRequirements: reqs({ answerFirst: true, concise: true, honestTradeoff: true }),
        gender: genderFor(true),
        directives: [
          "Answer the sizing/fit question for the product in context from its real fit/variant/review data — show ONLY that product's card. Do not browse other products.",
        ],
      });
    }
    return finalize({
      workflow: WORKFLOWS.SIZING_HELP,
      requiredEvidence: ["none"],
      searchRequired: false,
      clarificationAllowed: true,
      productDisplayPolicy: "suppress",
      answerRequirements: reqs({ concise: true }),
      gender: null,
      directives: [
        "Ask which product or category they're sizing, their usual size, width, and any fit issues (e.g. wide feet, high arch). Do NOT search the catalog or show any product cards or collection links.",
      ],
    });
  }

  // 1d. Orthotic COMPATIBILITY ("can I put orthotics inside the Jillian?"). A
  // direct yes/no about whether an insert fits a shoe — answered from the named
  // product's facts + orthotic knowledge. NOT a browse, NOT a stock check; never
  // surface random orthotic cards unless the customer asks to shop orthotics.
  if (isCompatibilityAsk(m)) {
    return finalize({
      workflow: WORKFLOWS.COMPATIBILITY,
      requiredEvidence: ["product_facts", "orthotic_knowledge"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: hasNamed ? "show_focused" : "suppress",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: genderFor(true),
      directives: [
        "Answer the compatibility question DIRECTLY (can the orthotic/insole go inside this shoe) from the named product's facts plus orthotic knowledge — e.g. removable footbed = yes, fixed = limited. Show ONLY the named product's card if any. Do NOT search for or show random orthotic products unless the customer explicitly asked to shop orthotics.",
      ],
    });
  }

  // 1e. MULTI-recommendation ("one sandal, one sneaker, and one slipper for heel
  // pain"). The turn carries 2+ distinct categories — it must be decomposed into
  // one slot per category and answered with ONE pick each, not a single broad
  // search that floods the carousel. The ConstraintPlan layer builds the slots.
  // BUT a comparison of two NAMED products ("compare the Sydney wedge and the
  // Rebecca heels") is a comparison, not a category multi — let it fall through.
  if (isMultiRecommendationAsk(m) && !(hasNamed && COMPARISON_RE.test(m))) {
    return finalize({
      workflow: WORKFLOWS.MULTI_RECOMMENDATION,
      requiredEvidence: ["product_facts"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: "show",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: genderFor(true),
      directives: [
        "The customer asked for MULTIPLE distinct categories. Recommend exactly ONE best product per category, one short line each, then show one card per category. Never flood the carousel or merge them into a single broad list.",
      ],
    });
  }

  // 2. Availability — size / color / stock for a product in context, OR a
  // size/stock FOLLOW-UP after products were shown ("what about size 9?" with
  // prior cards). The latter has no named product in the message but is clearly
  // an availability question, so it must not fall through to clarification.
  // Force a fresh product/variant lookup; never answer from prior cards alone.
  const isDeicticAvailFollowUp = FOLLOWUP_AVAIL_RE.test(m) && words(m) <= 5;
  if ((SIZE_COLOR_STOCK_RE.test(m) || isDeicticAvailFollowUp) && (hasProductContext || hasPriorCards)) {
    return finalize({
      workflow: WORKFLOWS.AVAILABILITY,
      requiredEvidence: ["variant_facts"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: "show_availability",
      answerRequirements: reqs({ answerFirst: true, concise: true, answerInText: true }),
      gender: genderFor(false),
      directives: [
        "Look up THIS product's live variants (sizes, colors, stock) this turn with get_product_details/lookup_sku — do NOT answer from earlier cards.",
        "Answer the availability question in TEXT (yes/no + which sizes/colors are in stock).",
        "ALWAYS show the product card on an availability question — never suppress it.",
      ],
    });
  }

  // 3. Comparison — explicit ("vs", "which is better") OR a short choice
  // between named products ("Jillian or Savannah?", "Jillian or something
  // else?").
  const isChoiceBetweenProducts = hasNamed && /\bor\b/i.test(m) && words(m) <= 14;
  if (COMPARISON_RE.test(m) || isChoiceBetweenProducts) {
    return finalize({
      workflow: WORKFLOWS.COMPARISON,
      requiredEvidence: ["product_facts"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: "show",
      answerRequirements: reqs({ answerFirst: true, concise: true, recommendOne: true }),
      gender: genderFor(condition || useCase),
      directives: [
        "COMPARISON CONTRACT — keep it SHORT (max ~120 words, under 5 sentences). " +
          "First sentence must answer directly: lean one product for the stated need and say why. " +
          "Structure: \"Pick X for Y. Choose Z if A. Here's why…\". At most 3 short facts per side. " +
          "No long paragraphs, no review-style essay. Show one card per product.",
      ],
    });
  }

  // 4. Named-product advisory / value / suitability.
  if (hasNamed && (ADVISORY_RE.test(m) || condition)) {
    return finalize({
      workflow: WORKFLOWS.NAMED_PRODUCT_ADVISORY,
      requiredEvidence: ["product_facts"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: "show_focused",
      answerRequirements: reqs({ answerFirst: true, concise: true, honestTradeoff: true }),
      gender: genderFor(true),
      directives: [
        "Look up the named product this turn and answer the value/suitability question directly from its real facts — answer first, one honest tradeoff, then the card. Never answer a named-product question from memory alone.",
      ],
    });
  }

  // 5. Condition / use-case recommendation. The key rule: do NOT ask gender
  // first — default to the primary line and SEARCH, then offer refinement.
  if (condition || useCase || RECOMMEND_RE.test(m)) {
    const genderUnstated = !statedGender;
    return finalize({
      workflow: WORKFLOWS.CONDITION_RECOMMENDATION,
      requiredEvidence: ["product_facts"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: "show",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: genderFor(true),
      directives: genderUnstated
        ? [
            `Gender is unstated — default to the ${primaryGender}'s line and SEARCH now. Do NOT ask "men's or women's?" first.`,
            "Show relevant products, then offer gender refinement as a soft next step (e.g. a Men's chip).",
          ]
        : ["Search the stated gender's line and show relevant products."],
    });
  }

  // 5b. Sale browse — the customer wants to SEE discounted products. A commerce
  // turn: search onSale with whatever category/gender constraints are present,
  // never a raw-sentence query, never a support punt. Placed before plain
  // browse so "what's on sale" routes here.
  if (SALE_BROWSE_RE.test(m)) {
    return finalize({
      workflow: WORKFLOWS.SALE_BROWSE,
      requiredEvidence: ["product_facts"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: "show",
      answerRequirements: reqs({ concise: true }),
      gender: genderFor(true),
      directives: [
        "Search the catalog for DISCOUNTED products (onSale=true), filtered by any stated category/gender, and show them. If active promo knowledge exists, mention it briefly; otherwise note codes are verified at checkout — but STILL show the sale products. Never say you can't access sales, and never link to Support.",
      ],
    });
  }

  // 6. Plain browse / search.
  if (BROWSE_RE.test(m) || hasNamed) {
    const genderUnstated = !statedGender;
    return finalize({
      workflow: WORKFLOWS.BROWSE,
      requiredEvidence: ["product_facts"],
      searchRequired: true,
      // A bare generic "shoes" browse with no category MAY ask one
      // narrowing question; a specific browse should just search.
      clarificationAllowed: genderUnstated && /\b(shoes?|footwear)\b/i.test(m) && words(m) <= 6,
      productDisplayPolicy: "show",
      answerRequirements: reqs({ concise: true }),
      // Default to the primary line (women) when the customer states no gender
      // — never infer men from a logged-in account/name. A stated men/women (or
      // husband/wife/etc.) still wins via resolveStatedGender.
      gender: genderFor(true),
      directives: ["Search and show matching products with a short framing sentence."],
    });
  }

  // 7. Clarification / no actionable data.
  return finalize({
    workflow: WORKFLOWS.CLARIFICATION,
    requiredEvidence: ["none"],
    searchRequired: false,
    clarificationAllowed: true,
    productDisplayPolicy: "suppress",
    answerRequirements: reqs({ concise: true }),
    gender: null,
    directives: ["Ask one focused clarifying question, or answer the general question directly if it needs no product data."],
  });
}

function finalize(plan) {
  // Stable shape + a couple of derived booleans the prompt/hooks read.
  return {
    workflow: plan.workflow,
    requiredEvidence: plan.requiredEvidence,
    searchRequired: plan.searchRequired,
    clarificationAllowed: plan.clarificationAllowed,
    productDisplayPolicy: plan.productDisplayPolicy,
    answerRequirements: plan.answerRequirements,
    gender: plan.gender ?? null,
    directives: plan.directives || [],
  };
}

// Generic-clarifier detection. When the plan says act-don't-ask
// (clarificationAllowed=false), these stock stall replies are a contract
// violation — the model should have searched and shown products instead.
// Conservative: only fires on SHORT question-shaped replies so a real
// product answer that ends with a soft refinement offer is never flagged.
const CLARIFIER_PATTERNS = [
  /\bmen'?s?\s+or\s+women'?s?\b/i,
  /\bwomen'?s?\s+or\s+men'?s?\b/i,
  /\b(are|is)\s+(you|this|it)\s+(shopping|looking)\s+for\b/i,
  /\bshopping\s+for\s+(yourself|a\s+man|a\s+woman|him|her|men|women)\b/i,
  /\btell\s+me\s+(a\s+(little|bit)\s+)?more\b/i,
  /\bcould\s+you\s+(tell|give)\s+me\s+(a\s+(little|bit)\s+)?more\b/i,
  /\b(what|which)\s+(style|color|colour|size|budget|type|kind|occasion)\b[^.?!]*\?/i,
  /\bany\s+(particular|specific)\s+(style|color|colour|budget|type|occasion)\b/i,
  /\bwhat'?s\s+your\s+budget\b/i,
];

// ── Executable gate deciders ──────────────────────────────────────────
// The chat route calls these so the gates and the eval test the SAME logic.

// The four workflows that owe the customer a real ANSWER (not just cards or a
// clarifier). A generic "take a look / closest matches" line — or a stock
// clarifier — is a contract violation for these; it forces a synthesis retry.
export const ANSWER_WORKFLOWS = new Set([
  WORKFLOWS.AVAILABILITY,
  WORKFLOWS.COMPARISON,
  WORKFLOWS.NAMED_PRODUCT_ADVISORY,
  WORKFLOWS.CONDITION_RECOMMENDATION,
  WORKFLOWS.MULTI_RECOMMENDATION,
  WORKFLOWS.COMPATIBILITY,
]);

export function isAnswerWorkflow(plan) {
  return Boolean(plan && ANSWER_WORKFLOWS.has(plan.workflow));
}

// Honest, evidence-grounded line used only at retry EXHAUSTION for an answer
// workflow — when the model never produced a real answer and we refuse to
// ship "take a look / closest matches". Names the products we DO have and
// states the situation plainly; never fabricates specs. Better than a generic
// non-answer, worse than a real synthesis (which the retry tries first).
export function buildAnswerWorkflowExhaustionText(plan, pool = []) {
  const titles = (Array.isArray(pool) ? pool : [])
    .map((c) => String(c?.title || "").trim())
    .filter(Boolean)
    .slice(0, 3);
  const g = plan?.gender === "men" || plan?.gender === "women" ? plan.gender : null;
  const lineup = titles.length ? titles.join(titles.length === 2 ? " and " : ", ") : null;
  switch (plan?.workflow) {
    case WORKFLOWS.AVAILABILITY:
      return lineup
        ? `I can't confirm that exact size/color combination from the data I have right now — here's the ${titles[0]} so you can check current availability.`
        : "I can't confirm that exact size/color from the data I have right now — let me know the product and I'll pull what's in stock.";
    case WORKFLOWS.COMPARISON:
      return lineup
        ? `Here ${titles.length === 1 ? "is" : "are"} ${lineup} side by side — take a close look at each, and tell me what matters most (support, cushioning, dressiness) so I can call a winner.`
        : "Tell me the two styles you're weighing and I'll compare them directly on support, cushioning, and fit.";
    case WORKFLOWS.NAMED_PRODUCT_ADVISORY:
      return lineup
        ? `Here's the ${titles[0]}${g ? ` from our ${g}'s line` : ""} — happy to break down whether it fits your need; tell me a bit more about how you'll use it.`
        : "Happy to weigh in — tell me the product and how you'll use it and I'll give you a straight take.";
    case WORKFLOWS.CONDITION_RECOMMENDATION:
    default:
      return lineup
        ? `Based on what you described, ${lineup} ${titles.length === 1 ? "is a" : "are"} solid${g ? ` ${g}'s` : ""} starting point — look for arch support and cushioning. Tell me more about fit or budget and I'll refine.`
        : "Tell me a bit more — the condition, how long you're on your feet, any style preference — and I'll recommend supportive options.";
  }
}

// Card-display authority: does the plan require products to be shown?
// When true, the emit-finalize step must not suppress cards just because the
// text is short or carries choice buttons.
export function planForcesProductDisplay(plan) {
  const d = plan?.productDisplayPolicy;
  return d === "show" || d === "show_availability" || d === "show_focused";
}

// Search authority: did the plan require a product search this turn?
export function planRequiresSearch(plan) {
  return plan?.searchRequired === true;
}

// Clarification authority. Given the plan, the model's reply, and whether
// products are available, decide what the caller should do:
//   "allow"             — fine as-is (clarification permitted or not a stall)
//   "repair"            — disallowed stall, products exist → swap in framing
//   "block_no_products" — disallowed stall, nothing to show → cannot repair
export function clarifierGateDecision(plan, text, hasProducts) {
  if (!plan || plan.clarificationAllowed !== false) return { action: "allow", reason: "clarification_allowed" };
  if (!isGenericClarifierReply(text)) return { action: "allow", reason: "not_a_clarifier" };
  return hasProducts
    ? { action: "repair", reason: "disallowed_clarifier_with_products" }
    : { action: "block_no_products", reason: "disallowed_clarifier_no_products" };
}

export function isGenericClarifierReply(text) {
  const t = String(text || "").trim();
  if (!t || !t.includes("?")) return false;
  // A real product presentation is longer; a stock clarifier is short.
  if (words(t) > 32) return false;
  return CLARIFIER_PATTERNS.some((re) => re.test(t));
}

// Plan-aware repair line used when a disallowed clarifier is replaced and
// products are available to carry the turn. Natural, no fabricated facts.
export function buildPlanClarifierRepair(plan) {
  const g = plan?.gender;
  if (g === "women" || g === "men") {
    const other = g === "women" ? "men's" : "women's";
    return `Here are some options I'd start with — I focused on our ${g}'s line, but just let me know if you'd like ${other} instead.`;
  }
  return "Here are some options that fit what you described — happy to refine by style, color, or budget if you'd like.";
}

// Render a compact, customer-invisible plan block for the system prompt.
export function buildTurnPlanPromptBlock(plan) {
  if (!plan || !plan.workflow) return "";
  const lines = [
    "=== TURN PLAN (internal — never mention this to the customer) ===",
    `Workflow: ${plan.workflow}`,
    `Search required: ${plan.searchRequired ? "YES — call a product tool before answering" : "no"}`,
    `Clarifying question allowed: ${plan.clarificationAllowed ? "yes (at most one)" : "NO — do not ask, act on what you have"}`,
    `Product display: ${plan.productDisplayPolicy}`,
  ];
  if (plan.gender) lines.push(`Gender to use: ${plan.gender} (do not ask — refine later if needed)`);
  for (const d of plan.directives) lines.push(`- ${d}`);
  return lines.join("\n");
}
