// =====================================================================
// TurnPlan — the single front-of-turn brain.
// =====================================================================
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
  BROWSE: "browse",
  CLARIFICATION: "clarification",
};

const POLICY_RE =
  /\b(return|returns|refund|exchange(?:s|d)?|warranty|guarantee|ship(?:ping|ped)?|delivery|deliver|track(?:ing)?|order\s+status|my\s+order|where\s+is\s+my|cancel(?:lation)?|account|sign\s+in|log\s+in|password|invoice|receipt)\b/i;

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

const GENDER_STATED_RE =
  /\b(men'?s?|male|man\b|guy|husband|boyfriend|\bdad\b|father|\bson\b|\bhis\b|\bhim\b|women'?s?|female|woman\b|wife|girlfriend|mom\b|mother|daughter|\bher\b)\b/i;

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
  const genderStated = GENDER_STATED_RE.test(m) || Boolean(attrs?.gender);
  const condition = Boolean(attrs?.condition) || CONDITION_RE.test(m);
  const useCase = Boolean(attrs?.useCase) || USECASE_RE.test(m);

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

  // 2. Availability — size / color / stock for a product in context.
  // Force a fresh product/variant lookup; never answer from prior cards
  // alone; never suppress the card on an availability question.
  if (hasProductContext && SIZE_COLOR_STOCK_RE.test(m)) {
    return finalize({
      workflow: WORKFLOWS.AVAILABILITY,
      requiredEvidence: ["variant_facts"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: "show_availability",
      answerRequirements: reqs({ answerFirst: true, concise: true, answerInText: true }),
      gender: genderStated ? attrs?.gender || null : null,
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
      gender: genderStated ? attrs?.gender || null : (condition || useCase ? primaryGender : null),
      directives: [
        "Look up both products this turn, then give a concise direct verdict (recommend one) with the key tradeoff. Show both cards.",
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
      gender: genderStated ? attrs?.gender || null : primaryGender,
      directives: [
        "Look up the named product this turn and answer the value/suitability question directly from its real facts — answer first, one honest tradeoff, then the card. Never answer a named-product question from memory alone.",
      ],
    });
  }

  // 5. Condition / use-case recommendation. The key rule: do NOT ask gender
  // first — default to the primary line and SEARCH, then offer refinement.
  if (condition || useCase || RECOMMEND_RE.test(m)) {
    const genderUnstated = !genderStated;
    return finalize({
      workflow: WORKFLOWS.CONDITION_RECOMMENDATION,
      requiredEvidence: ["product_facts"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: "show",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: genderStated ? attrs?.gender || null : primaryGender,
      directives: genderUnstated
        ? [
            `Gender is unstated — default to the ${primaryGender}'s line and SEARCH now. Do NOT ask "men's or women's?" first.`,
            "Show relevant products, then offer gender refinement as a soft next step (e.g. a Men's chip).",
          ]
        : ["Search the stated gender's line and show relevant products."],
    });
  }

  // 6. Plain browse / search.
  if (BROWSE_RE.test(m) || hasNamed) {
    const genderUnstated = !genderStated;
    return finalize({
      workflow: WORKFLOWS.BROWSE,
      requiredEvidence: ["product_facts"],
      searchRequired: true,
      // A bare generic "shoes" browse with no category MAY ask one
      // narrowing question; a specific browse should just search.
      clarificationAllowed: genderUnstated && /\b(shoes?|footwear)\b/i.test(m) && words(m) <= 6,
      productDisplayPolicy: "show",
      answerRequirements: reqs({ concise: true }),
      gender: genderStated ? attrs?.gender || null : (genderUnstated ? null : primaryGender),
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
