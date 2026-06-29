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
  CUSTOMER_SERVICE: "customer_service",
  AVAILABILITY: "availability",
  PRIOR_EVIDENCE_AVAILABILITY: "prior_evidence_availability",
  COMPARISON: "comparison",
  NAMED_PRODUCT_ADVISORY: "named_product_advisory",
  CONDITION_RECOMMENDATION: "condition_recommendation",
  MULTI_RECOMMENDATION: "multi_recommendation",
  COMPATIBILITY: "compatibility",
  SALE_BROWSE: "sale_browse",
  SIZING_HELP: "sizing_help",
  PRODUCT_FOCUS: "product_focus",
  CART_HANDOFF: "cart_handoff",
  DISPLAY_RECOVERY: "display_recovery",
  BROWSE: "browse",
  CLARIFICATION: "clarification",
};

// Does the assistant text PRESENT products to the customer ("here are…", "I
// found…", "a few options", "5 picks")? Used to (a) protect real product
// evidence from the clarification card-wipe and (b) detect a
// cards-promised-but-none-shown display failure. Exported + pure.
export function textPresentsProducts(text) {
  const t = String(text || "");
  return /\b(?:here(?:'s|\s+are|\s+is)|these\s+are|i(?:'ve|\s+have)?\s+found|i\s+found|take\s+a\s+look|check\s+(?:out|these)|below\s+are|a\s+few\s+(?:options|picks|styles|pairs)|some\s+(?:options|picks|great|solid)|\d+\s+(?:options|picks|styles|pairs|great)|my\s+(?:top\s+)?(?:picks|recommendations)|recommend(?:ed)?\s+(?:these|the\s+following)|pulled\s+(?:up|together)|found\s+(?:you\s+)?(?:a\s+few|some|\d+))\b/i.test(t);
}

// A GENDER-ONLY refinement of a prior shopping turn: "how about mens?", "men's?",
// "for men", "women's instead", "what about for my husband". On its own it's not
// a clarification — it re-runs the prior search with the gender swapped.
const GENDER_REFINE_TOKEN_RE =
  /\b(men'?s?|man|male|guys?|husband|boyfriend|women'?s?|woman|female|wife|girlfriend|ladies|lady|kids?|child(?:ren)?|boys?|girls?|toddlers?)\b/i;
const GENDER_REFINE_OTHER_CONTENT_RE =
  /\b(sandals?|sneakers?|boots?|shoes?|footwear|loafers?|clogs?|slippers?|heels?|wedges?|orthotics?|insoles?|sale|cheap|under|size|color|colour|black|white|navy|tan|pink|red|blue|green|brown|grey|gray|walking|standing|running|hiking|work|wedding|travel|plantar|bunion|arch)\b/i;

// "I can't see any" / "nothing showed up" — a DISPLAY complaint about products
// the bot said it showed. Recovery, not a fresh clarification.
const DISPLAY_COMPLAINT_RE =
  /\b(?:can'?t|cannot|can\s?not|don'?t|do\s+not|couldn'?t|didn'?t)\s+see\s+(?:any|anything|them|it|the|a|product|the\s+product)|nothing\s+(?:is\s+)?(?:show|showed|showing|there|here|load|loaded|appearing)|(?:no|zero)\s+(?:products?|cards?|results?|images?|pictures?)\b|where\s+(?:are|did|is)\s+(?:they|the|it)|not\s+showing|isn'?t\s+showing|didn'?t\s+(?:show|load|appear)|i\s+see\s+nothing|(?:it'?s|its|the\s+\w+\s+is)\s+blank|nothing\s+came\s+up|don'?t\s+see\s+(?:any|the)/i;

// A product SELECTION / focus follow-up: the customer is picking one of the
// cards they were just shown. "I like the Drew", "I'll take this one", "that
// one looks good", "go with the second one". This is NOT a generic browse —
// anchor the chosen product and answer with concise sales copy + a next step.
const SELECTION_RE = new RegExp(
  "\\bi\\s+(?:like|love|want|prefer|choose|pick)\\s+(?:the|this|that|these|those)\\b" + "|" +
  "\\bi'?(?:ll|d)\\s+(?:take|go\\s+with|get)\\b" + "|" +
  "\\b(?:let'?s|let\\s+me)\\s+(?:go\\s+with|get|take)\\b" + "|" +
  "\\bgo\\s+with\\s+the\\b" + "|" +
  "\\b(?:this|that)\\s+one\\s+(?:looks?\\s+(?:good|great|nice|perfect)|works?|it\\s+is)\\b" + "|" +
  "\\bthe\\s+(?:first|second|third|fourth|fifth|last)\\s+one\\b",
  "i",
);

// CART / checkout / purchase intent on the FOCUSED product. A committed action
// on a deictic object ("add it to my cart", "I want to buy it", "checkout") —
// NOT a deliberation ("should I buy the Reagan?", that's advisory) and NOT a
// category shopping intent ("I want to buy some sandals", that's a browse).
const CART_RE = new RegExp(
  "\\badd\\s+(?:it|this|that|these|them)?\\s*to\\s+(?:my\\s+)?(?:cart|bag|basket|order)\\b" + "|" +
  "\\badd\\s+to\\s+(?:cart|bag|basket)\\b" + "|" +
  "\\bput\\s+(?:it|this|that|these)\\s+in\\s+(?:my\\s+)?(?:cart|bag|basket)\\b" + "|" +
  "\\b(?:i'?(?:ll|d)|let\\s+me|i\\s+want\\s+to|i\\s+wanna|i'?m\\s+gonna)\\s+(?:buy|purchase|order|get)\\s+(?:it|this|that|these|them|one)\\b" + "|" +
  "\\b(?:buy|purchase|order)\\s+(?:it|this|that|these|them)\\b" + "|" +
  "\\bcheck(?:ing)?\\s*out\\b|\\bcheckout\\b|\\bproceed\\s+to\\s+(?:checkout|pay)\\b",
  "i",
);

const POLICY_RE =
  /\b(return|returns|refund|exchange(?:s|d)?|warranty|guarantee|ship(?:ping|ped)?|delivery|deliver|track(?:ing)?|order\s+status|my\s+order|where\s+is\s+my|cancel(?:lation)?|account|sign\s+in|log\s+in|password|invoice|receipt)\b/i;

// CUSTOMER SERVICE — a problem/issue with a specific order, shipment, delivery,
// payment, or account that needs a HUMAN (not a policy FAQ answer). These get a
// live-chat handoff, never a product search or cards. Distinct from POLICY_RE,
// which answers an informational policy question ("what's your return policy?")
// from knowledge. The signals here are an ACTION/PROBLEM, not a question about
// the rules: missing/late/wrong/damaged delivery, an explicit refund/return/
// exchange/cancel request, an order lookup, or an account-access issue.
const CUSTOMER_SERVICE_RE = new RegExp(
  // delivery / package problems
  "\\b(?:says?|marked|shows?)\\s+delivered\\b" + "|" +
  "\\b(?:never|didn'?t|did\\s+not|hasn'?t|has\\s+not|not)\\s+(?:get|got|receive[d]?|arrive[d]?|come|deliver(?:ed)?|show(?:n|\\s+up)?)\\b" + "|" +
  "\\b(?:missing|lost|stolen|late|delayed|wrong|damaged|defective|broken|torn|ripped)\\s+(?:package|parcel|order|item|shipment|delivery|product|shoe|pair)s?\\b" + "|" +
  "\\b(?:package|parcel|order|shipment|delivery)\\s+(?:never|hasn'?t|has\\s+not|didn'?t|did\\s+not|isn'?t|is\\s+not)\\b" + "|" +
  "\\bwrong\\s+(?:item|size|color|colour|product|pair|order)\\b" + "|" +
  "\\b(?:received|got|sent\\s+me)\\s+the\\s+wrong\\b" + "|" +
  // explicit action requests on an order
  "\\b(?:i\\s+(?:want|need|'?d\\s+like|would\\s+like)\\s+to|how\\s+do\\s+i|can\\s+i|help\\s+me)\\s+(?:return|refund|exchange|cancel|replace)\\b" + "|" +
  "\\b(?:i\\s+(?:want|need|'?d\\s+like|would\\s+like))\\s+(?:a\\s+)?refund\\b" + "|" +
  "\\b(?:return|exchange|cancel|replace)\\s+(?:my|this|these|the|an?)\\s+(?:order|item|pair|purchase|shoe)s?\\b" + "|" +
  // order lookup / problem with order
  "\\bwhere'?s?\\s+my\\s+(?:order|package|stuff|shipment)\\b" + "|" +
  "\\bwhere\\s+is\\s+my\\s+(?:order|package|shipment|delivery)\\b" + "|" +
  "\\btrack\\s+(?:my\\s+)?(?:order|package|shipment)\\b" + "|" +
  "\\border\\s+(?:status|number|#|problem|issue)\\b" + "|" +
  "\\b(?:problem|issue|help|trouble|wrong)\\s+with\\s+(?:my|an|this|the)\\s+(?:order|delivery|package|shipment|payment|account|return|refund)\\b" + "|" +
  // payment / account access issues
  "\\b(?:charged|double[-\\s]?charged|overcharged|charged\\s+twice)\\b" + "|" +
  "\\b(?:can'?t|cannot|unable\\s+to)\\s+(?:log\\s+in|sign\\s+in|access\\s+my\\s+account|reset\\s+my\\s+password)\\b" + "|" +
  "\\b(?:reset|forgot)\\s+my\\s+password\\b|\\block(?:ed)?\\s+out\\s+of\\s+my\\s+account\\b",
  "i",
);

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

// Outfit/styling advisory: "wear Gabby with a white dress", "does Jillian go
// with jeans?", "can I wear Savannah to a wedding?", "what shoes go with...".
// A NAMED product + styling phrasing is advice ABOUT that product (show it,
// keep it dominant) — NOT a generic color/category browse seeded by the outfit
// the customer described (live trace 2026-06-29: "wear gabby with a white dress
// with big red flowers" became a red-footwear browse with Gabby dropped).
const STYLING_RE = new RegExp(
  "\\bwear\\b[^.?!\\n]{0,40}\\b(?:with|to|for)\\b" + "|" +
  "\\b(?:go|goes|pair|pairs|match|matches|work|works)\\b[^.?!\\n]{0,20}\\bwith\\b" + "|" +
  "\\bgo(?:es)?\\s+(?:well\\s+)?with\\b" + "|" +
  "\\bwhat\\s+(?:shoes?|sandals?|footwear|heels?|wedges?|boots?|sneakers?)\\s+(?:go|would|to\\s+wear)\\b" + "|" +
  "\\b(?:match|pair\\s+with)\\s+(?:my|a|an|the)\\b",
  "i",
);

// Medical CONDITIONS only — "arch support" is a feature/filter, not a
// condition, so it is deliberately excluded (otherwise "show me sandals
// with arch support" misclassifies as a clinical recommendation).
const CONDITION_RE =
  /\b(plantar|fasciitis|bunion|bunions|neuroma|metatarsal|metatarsalgia|overpronat\w*|supinat\w*|sesamoid|capsulitis|fallen\s+arch\w*|high\s+arch\w*|flat\s+feet|heel\s+(?:pain|spur)|arch\s+pain|achilles|neuropathy|diabetic|foot\s+pain|ball\s+of\s+foot)\b/i;

const USECASE_RE =
  /\b(walking|standing|all[-\s]?day|on\s+my\s+feet|vacation|travel|trip|hiking|running|gym|workout|wedding|work|nurse|nursing|teacher|tourism|sightseeing|theme\s+park|disney|cruise)\b/i;

const BROWSE_RE =
  /\b(show\s+me|do\s+you\s+(?:have|carry|sell)|looking\s+for|i\s+(?:want|need)\b|browse|what\s+(?:sandals?|shoes?|footwear|boots?|sneakers?|clogs?|loafers?|slippers?|heels?|wedges?)\s+(?:do\s+you|are)|under\s+\$?\d+|recommend)\b/i;

const RECOMMEND_RE =
  /\b(what\s+(?:would|do)\s+you\s+recommend|what\s+should\s+i\s+(?:get|buy|wear)|help\s+me\s+(?:find|pick|choose)|need\s+(?:a\s+)?(?:sandal|shoe|footwear|sneaker|boot|something))\b/i;

// A bare affirmation — "yes", "sure", "ok", "please do", "go ahead". On its own
// it carries no intent; it INHERITS the action the assistant just offered.
const AFFIRM_RE =
  /^\s*(?:yes|yep|yeah|yup|ya|sure|ok|okay|k|please|yes\s+please|please\s+do|do\s+it|go\s+ahead|sounds?\s+good|that\s+works|let'?s\s+do\s+it|absolutely|definitely|of\s+course|why\s+not)\b/i;
// The assistant's prior OFFER, parsed from its last message.
const OFFER_SIMILAR_RE =
  /\b(similar|alternativ\w*|other\s+(?:options|styles|ones|pairs)|more\s+(?:options|styles|like)|something\s+else|comparable|compare\s+it)\b/i;
const OFFER_VARIANTS_RE =
  /\b(?:check|see|look\s+up|pull\s+up|find\s+out)\b[^.?!\n]{0,40}\b(?:sizes?|colors?|colours?|availability|stock|in\s+stock|what'?s\s+available)\b|\b(?:sizes?|colors?|colours?)\b[^.?!\n]{0,20}\b(?:available|in\s+stock|options)\b|\bwant\s+me\s+to\s+(?:check|see|look)\b/i;

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
 * @param {string[]} [input.priorCardFamilies] distinct families of the previously
 *   displayed cards — drives prior_evidence_availability when a color/size/width
 *   follow-up targets a SET of products (2+ families) the customer just saw.
 * @param {string} [input.primaryGender] merchant's primary line (default "women")
 * @returns {object} plan
 */
export function planTurn({
  message = "",
  attrs = {},
  namedProduct = false,
  focusProduct = null,
  hasPriorCards = false,
  priorCardFamilies = [],
  priorAssistantText = "",
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

  // 0. Customer-service ISSUE — a problem with a specific order / shipment /
  // delivery / payment / account that needs a HUMAN. Routed BEFORE policy and
  // browse so "an order that says delivered but I didn't get it" never falls
  // through to a product search. No search, no cards — emit the live-chat CTA.
  if (CUSTOMER_SERVICE_RE.test(m)) {
    return finalize({
      workflow: WORKFLOWS.CUSTOMER_SERVICE,
      requiredEvidence: ["policy_or_order_data"],
      searchRequired: false,
      clarificationAllowed: false,
      productDisplayPolicy: "suppress",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: null,
      directives: [
        "This is a customer-service issue with a specific order, shipment, delivery, payment, or account — it needs a human. Reply with ONE friendly, specific sentence acknowledging the problem and saying our customer service team can look it up and help. Do NOT search the catalog, do NOT show product cards, and do NOT invent order details. A live-chat button is attached for you.",
      ],
    });
  }

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
        "Keep it SHORT: 2-3 sentences MAX, direct answer first. No product cards unless a specific product was named in the conversation.",
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
  const isAvailFollowUpMsg = SIZE_COLOR_STOCK_RE.test(m) || isDeicticAvailFollowUp;

  // 2a. PRIOR-EVIDENCE availability — a color/size/width follow-up applied to a
  // SET of previously displayed products ("do they come in black?",
  // "what about size 8?", "do all three come in wide?") after the last turn
  // showed 2+ distinct product families (e.g. an evidence-plan trio or a
  // comparison pair). The customer didn't name a NEW product — "they"/"these"
  // refer back to what they just saw. Single-family availability can't resolve a
  // set (it finds no family and the scorer leaks unrelated cards), so this gets
  // its own deterministic owner that remaps EACH prior family to the new
  // constraint. Gated to no newly-named product so "do you have the Jillian in
  // black?" still routes to normal availability.
  const priorFamCount = Array.isArray(priorCardFamilies)
    ? new Set(priorCardFamilies.filter(Boolean)).size
    : 0;
  if (isAvailFollowUpMsg && !hasNamed && priorFamCount >= 2) {
    return finalize({
      workflow: WORKFLOWS.PRIOR_EVIDENCE_AVAILABILITY,
      requiredEvidence: ["variant_facts"],
      // Cards are remapped deterministically per prior family in chat.jsx — the
      // model must NOT run a broad search that would surface unrelated products.
      searchRequired: false,
      clarificationAllowed: false,
      productDisplayPolicy: "show_availability",
      answerRequirements: reqs({ answerFirst: true, concise: true, answerInText: true }),
      gender: genderFor(false),
      directives: [
        "The customer is asking whether the products you JUST showed come in a new color/size/width. Answer about THOSE SAME products only — never introduce new ones.",
        "Answer briefly per item (which of the shown products are available in the requested color/size, which are not).",
        "Show only the matching prior products' cards. If none match, show no cards and offer to look for alternatives.",
      ],
    });
  }

  if (isAvailFollowUpMsg && (hasProductContext || hasPriorCards)) {
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

  // 3b. CART / checkout intent — the customer wants to BUY the focused product.
  // The chat widget can't add to cart, so hand off to the product page and keep
  // the focused card. Never a generic browse or clarification.
  if (CART_RE.test(m) && (hasProductContext || hasPriorCards)) {
    return finalize({
      workflow: WORKFLOWS.CART_HANDOFF,
      requiredEvidence: ["product_facts"],
      searchRequired: false,
      clarificationAllowed: false,
      productDisplayPolicy: "show_focused",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: genderFor(false),
      directives: [
        "The customer wants to buy the product in focus. You can't add to cart from chat — say that briefly and point them to the product page to choose a size and add it there. KEEP the focused product's card. Do not start a new search or ask a generic clarifying question.",
      ],
    });
  }

  // 3c. PRODUCT SELECTION / FOCUS — the customer is picking one of the cards
  // they were just shown ("I like the Drew", "I'll take this one", "the second
  // one"). Anchor that product; answer with concise sales copy + a next step.
  // searchRequired=false so it can never trip search_required_not_attempted
  // (live trace 2026-06-29: "I like the Drew" → browse → forced search refused
  // → VIOLATION). The card comes from prior evidence / the named family.
  if (SELECTION_RE.test(m) && (hasProductContext || hasPriorCards || Boolean(focusProduct))) {
    return finalize({
      workflow: WORKFLOWS.PRODUCT_FOCUS,
      requiredEvidence: ["product_facts"],
      searchRequired: false,
      clarificationAllowed: false,
      productDisplayPolicy: "show_focused",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: genderFor(false),
      directives: [
        "The customer just SELECTED a product they were shown. Acknowledge it in one warm line of sales copy and offer one concrete next step (check sizes/colors, or compare it with a similar style). KEEP that product's card. Do NOT run a new generic search or ask a generic clarifying question.",
      ],
    });
  }

  // 4. Named-product advisory / value / suitability / styling.
  if (hasNamed && (ADVISORY_RE.test(m) || STYLING_RE.test(m) || condition)) {
    const styling = STYLING_RE.test(m) && !ADVISORY_RE.test(m) && !condition;
    return finalize({
      workflow: WORKFLOWS.NAMED_PRODUCT_ADVISORY,
      requiredEvidence: ["product_facts"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: "show_focused",
      answerRequirements: reqs({ answerFirst: true, concise: true, honestTradeoff: !styling }),
      gender: genderFor(true),
      directives: styling
        ? [
            "This is a STYLING question about the NAMED product. Search for and show the named product — it is the subject and must be the card shown. Give concise styling advice on how it pairs with the outfit the customer described. The colors/patterns in the outfit (e.g. a white dress, red flowers, blue jeans) are NOT product filters — never search a different color/category because of the outfit. If the customer didn't name a product COLOR, don't apply one.",
          ]
        : [
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
      directives: [
        "Recommend 2-3 specific products (not a long list) and name each one you show. The displayed cards are exactly the products you name — never reference a product you aren't showing.",
        ...(genderUnstated
          ? [
              `Gender is unstated — default to the ${primaryGender}'s line and SEARCH now. Do NOT ask "men's or women's?" first.`,
              "Offer gender refinement as a soft next step (e.g. a Men's chip).",
            ]
          : ["Search the stated gender's line and show the 2-3 best matches."]),
      ],
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

  // 5c. DISPLAY RECOVERY — "I can't see any", "nothing showed up" after the bot
  // said it showed products. This is a rendering complaint, NOT a fresh
  // clarification: re-show the previous cards with a brief apology. Gated on
  // real prior product context (cards shown, or the prior reply presented
  // products) so a genuine "I don't see what I want" stays a browse.
  if (
    DISPLAY_COMPLAINT_RE.test(m) && words(m) <= 8 &&
    (hasPriorCards || textPresentsProducts(priorAssistantText))
  ) {
    return finalize({
      workflow: WORKFLOWS.DISPLAY_RECOVERY,
      requiredEvidence: ["product_facts"],
      searchRequired: false,
      clarificationAllowed: false,
      productDisplayPolicy: "show",
      answerRequirements: reqs({ concise: true }),
      gender: genderFor(false),
      directives: [
        "The customer says the products didn't display. Re-show the SAME products from the previous turn with a brief apology ('Sorry about that — here they are again.'). Do NOT ask a new clarifying question and do NOT run a new search.",
      ],
    });
  }

  // 5d. GENDER-ONLY REFINEMENT — "how about mens?", "for men", "women's
  // instead". After a prior shopping turn this swaps the gender and re-runs the
  // SAME search; it must NEVER be a clarification (live trace 2026-06-29: "how
  // about mens?" → clarification → 5 found men's cards wiped). Requires prior
  // product context and no other query content (a real "men's sandals" browse
  // has a category and routes to section 6 normally).
  const isGenderOnlyRefine =
    GENDER_REFINE_TOKEN_RE.test(m) && words(m) <= 5 && !GENDER_REFINE_OTHER_CONTENT_RE.test(m);
  // A bare PRICE-DOWN refinement ("anything cheaper?", "less expensive") after a
  // prior shopping turn re-runs the SAME search biased to lower price — also a
  // refinement, not a clarification.
  const isPriceDownRefine =
    /\b(cheaper|less\s+expensive|more\s+affordable|lower(?:\s+(?:price|cost))?|anything\s+cheaper|something\s+cheaper|on\s+a\s+budget|budget[- ]friendly)\b/i.test(m) &&
    words(m) <= 6;
  if (isPriceDownRefine && !isGenderOnlyRefine && (hasPriorCards || hasProductContext)) {
    return finalize({
      workflow: WORKFLOWS.BROWSE,
      requiredEvidence: ["product_facts"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: "show",
      answerRequirements: reqs({ concise: true }),
      gender: genderFor(false),
      directives: [
        "The customer is REFINING the previous search to a lower price. Re-run the SAME kind of search (inherit the prior category/gender/use-case) sorted toward more affordable options and SHOW them. Do NOT ask a clarifying question.",
      ],
    });
  }
  if (isGenderOnlyRefine && (hasPriorCards || hasProductContext)) {
    const refineGender =
      /\b(men'?s?|man|male|guys?|husband|boyfriend|him|his)\b/i.test(m) ? "men"
      : /\b(women'?s?|woman|female|wife|girlfriend|ladies|lady|her)\b/i.test(m) ? "women"
      : /\b(kids?|child(?:ren)?|boys?|girls?|toddlers?)\b/i.test(m) ? "kids"
      : genderFor(true);
    return finalize({
      workflow: WORKFLOWS.BROWSE,
      requiredEvidence: ["product_facts"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: "show",
      answerRequirements: reqs({ concise: true }),
      gender: refineGender,
      directives: [
        "The customer is REFINING the previous search to a different gender. Re-run the SAME kind of search (inherit the prior category/use-case from context) for the new gender and SHOW the matching products. Do NOT ask a clarifying question.",
      ],
    });
  }

  // 6. Plain browse / search. Unnamed styling ("what shoes go with a black
  // dress?") is a browse — show footwear — not a dead-end clarification; the
  // outfit color is already stripped from the product filters upstream (D1).
  if (BROWSE_RE.test(m) || hasNamed || STYLING_RE.test(m)) {
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

  // 6b. Bare affirmation resolving against the prior assistant OFFER. A lone
  // "yes" carries no intent — it inherits the action the bot just offered (live
  // trace 2026-06-29: "yes" became a generic clarification, the model called a
  // tool anyway, and the resulting card was wiped). Resolve it to that action;
  // with no actionable offer it falls through to clarification (tools blocked).
  const isBareAffirmation = AFFIRM_RE.test(m) && words(m) <= 4;
  if (isBareAffirmation && priorAssistantText) {
    const prior = String(priorAssistantText);
    const hasFocus = hasProductContext || hasPriorCards || Boolean(focusProduct);
    if (OFFER_VARIANTS_RE.test(prior) && hasFocus) {
      return finalize({
        workflow: WORKFLOWS.AVAILABILITY,
        requiredEvidence: ["variant_facts"],
        searchRequired: true,
        clarificationAllowed: false,
        productDisplayPolicy: "show_availability",
        answerRequirements: reqs({ answerFirst: true, concise: true, answerInText: true }),
        gender: genderFor(false),
        directives: [
          "The customer said YES to checking sizes/colors for the product just discussed. Look up THAT product's live variants and answer which sizes/colors are in stock; if a pick is needed, ask which size/color. Keep its card.",
        ],
      });
    }
    if (OFFER_SIMILAR_RE.test(prior) && hasFocus) {
      return finalize({
        workflow: WORKFLOWS.BROWSE,
        requiredEvidence: ["product_facts"],
        searchRequired: true,
        clarificationAllowed: false,
        productDisplayPolicy: "show",
        answerRequirements: reqs({ concise: true }),
        gender: genderFor(false),
        directives: [
          "The customer said YES to seeing similar alternatives. Search for products similar to the one just discussed and show a few — do NOT ask a generic clarifying question.",
        ],
      });
    }
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
  WORKFLOWS.PRIOR_EVIDENCE_AVAILABILITY,
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
    case WORKFLOWS.PRIOR_EVIDENCE_AVAILABILITY:
      return lineup
        ? `I can't confirm that exact size and color combination right now — here's the ${titles[0]} so you can check current availability.`
        : "I can't confirm that exact size and color right now — let me know the product and I'll check what's in stock for you.";
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

// ── Hard ownership invariants (OBSERVE — used by the turn-invariant log) ──
// Workflows whose final cards are owned by a DETERMINISTIC selector
// (availability-truth / prior-evidence remap / comparison pin / evidence-plan),
// never the broad keyword scorer. If one of these ships cards owned by the
// scorer, a legacy selector leaked past the pin and re-decided the turn.
export const PINNED_CARD_WORKFLOWS = new Set([
  WORKFLOWS.AVAILABILITY,
  WORKFLOWS.PRIOR_EVIDENCE_AVAILABILITY,
  WORKFLOWS.COMPARISON,
  WORKFLOWS.MULTI_RECOMMENDATION,
  WORKFLOWS.COMPATIBILITY,
  WORKFLOWS.NAMED_PRODUCT_ADVISORY,
]);

// INVARIANT: a TurnPlan-pinned workflow that ships cards must NOT be owned by
// the scorer. Returns true on violation.
export function plannedWorkflowCardOwnerViolation({ workflow, finalCards = 0, cardOwner } = {}) {
  return PINNED_CARD_WORKFLOWS.has(workflow) && finalCards > 0 && cardOwner === "scorer";
}

// INVARIANT (audit #6): every product card SHOWN must be a product the turn
// actually retrieved — i.e. present in the evidence pool. Cleanup may remove a
// card but must NEVER add an unrelated one; a scorer-injected or cleanup-
// resurrected card that isn't in the pool is a hallucination risk. Returns the
// STRAY final cards (those whose handle/title is not in the evidence pool);
// empty array = clean. Matches on handle first, title as a fallback.
export function cardsNotInEvidencePool({ finalCards = [], evidencePool = [] } = {}) {
  const poolKeys = new Set();
  for (const c of evidencePool || []) {
    if (c?.handle) poolKeys.add(String(c.handle).toLowerCase());
    if (c?.title) poolKeys.add(String(c.title).toLowerCase());
  }
  if (poolKeys.size === 0) return [];
  return (finalCards || []).filter((c) => {
    const h = c?.handle ? String(c.handle).toLowerCase() : "";
    const t = c?.title ? String(c.title).toLowerCase() : "";
    return !(h && poolKeys.has(h)) && !(t && poolKeys.has(t));
  });
}

// INVARIANT: when TurnPlan requires a search AND requires product display, the
// turn must not finish without attempting a search — unless the resolved
// workflow itself became text-only/support (display=suppress). Returns true on
// violation.
export function plannedSearchSkippedViolation({ plan, searchAttempted } = {}) {
  if (!plan) return false;
  if (plan.searchRequired !== true) return false;
  if (!planForcesProductDisplay(plan)) return false;
  return searchAttempted !== true;
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
  if (plan.gender) {
    // For answer workflows where gender is already resolved/defaulted and no
    // clarification is allowed, be EXPLICIT and absolute: the model must not ask
    // gender or emit gender chips. Leaving it as a soft "refine later" let the
    // model still open with "women's or men's?" + <<Women's>>/<<Men's>> chips,
    // which then get stripped downstream → validator retry loop → empty-text
    // repair (prod trace). Killing it at the prompt is the primary fix.
    if (plan.clarificationAllowed === false && ANSWER_WORKFLOWS.has(plan.workflow)) {
      lines.push(
        `Gender: ${plan.gender} — ALREADY RESOLVED/DEFAULTED by TurnPlan. Do NOT ask "men's or women's?", ` +
          `and do NOT emit <<Men's>>/<<Women's>> chips. Search the ${plan.gender}'s line now; ` +
          `mention the other line only as plain words later if it's genuinely relevant.`,
      );
    } else {
      lines.push(`Gender to use: ${plan.gender} (do not ask — refine later if needed)`);
    }
  }
  for (const d of plan.directives) lines.push(`- ${d}`);
  return lines.join("\n");
}
