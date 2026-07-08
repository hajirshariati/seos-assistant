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
  // Answer-source split (2026-07): a policy/FAQ/discount/verification/brand/tech/
  // sizing-guide question is ANSWERABLE from knowledge (RAG-first) — it is NOT a
  // support handoff. A private account/order/verification-OUTCOME issue needs a
  // human. POLICY_ACCOUNT / CUSTOMER_SERVICE are kept as legacy aliases so older
  // callers/tests still resolve; planTurn now emits the explicit names below.
  POLICY_KNOWLEDGE: "policy_knowledge",
  ACCOUNT_PRIVATE_HANDOFF: "account_private_handoff",
  POLICY_ACCOUNT: "policy_account",
  CUSTOMER_SERVICE: "customer_service",
  AVAILABILITY: "availability",
  PRIOR_EVIDENCE_AVAILABILITY: "prior_evidence_availability",
  COMPARISON: "comparison",
  NAMED_PRODUCT_ADVISORY: "named_product_advisory",
  CONDITION_RECOMMENDATION: "condition_recommendation",
  MULTI_RECOMMENDATION: "multi_recommendation",
  COMPATIBILITY: "compatibility",
  PRODUCT_SPEC: "product_spec",
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

// A "stripped fragment" is what safety cleanup can leave behind when it removes
// a clarifier/narration sentence from the MIDDLE or END of a reply: a short,
// dangling clause that no longer stands as a complete answer (and often refers
// to the very question that was removed — "That one detail will get you to the
// right pick."). Heuristic: very short, OR a short reply that promises a
// follow-on ("that detail", "once you…", "let me know") without ever presenting
// the products. Callers only apply this to a turn that actually shows cards.
const FRAGMENT_DANGLER_RE =
  /\b(?:that\s+(?:one\s+)?detail|that'?ll|that\s+will\s+get\s+you|once\s+(?:you|i)\b|just\s+(?:that|one)\b|let\s+me\s+know|then\s+i'?ll|from\s+there)\b/i;
export function isStrippedFragmentText(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  // A complete reply that already presents the products is fine.
  if (textPresentsProducts(t)) return false;
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words <= 6 || t.length < 30) return true;
  // A short-ish reply (no product pitch) that dangles on a follow-on promise.
  if (words <= 22 && FRAGMENT_DANGLER_RE.test(t)) return true;
  return false;
}

// Is this displayed card an orthotic/insole product (vs wearable footwear)? The
// orthotic recommender only ever returns these; a footwear card under an
// orthotic answer is a leak. Matches the category/productType OR the title — the
// title check catches under-tagged SKUs (same shape as the visualize-CTA insole
// guard). Bare "orthotic" in a title is allowed only when it isn't paired with a
// wearable footwear noun (a real sandal can be "Maui Orthotic Flip").
const ORTHOTIC_CARD_CATEGORY_RE = /\b(?:orthotic|insole|insert|footbed|foot[\s-]*bed|arch[\s-]*support)/i;
const ORTHOTIC_CARD_TITLE_RE = /\b(?:insole|insert|footbed|foot[\s-]*bed)s?\b/i;
const WEARABLE_FOOTWEAR_NOUN_RE = /\b(?:sandals?|flip|flop|slides?|sneakers?|shoes?|boots?|loafers?|heels?|wedges?|clogs?|mules?|flats?|pumps?)\b/i;
export function isOrthoticProductCard(card) {
  if (!card || typeof card !== "object") return false;
  const category = String(card.category || card._category || card.productType || "");
  if (ORTHOTIC_CARD_CATEGORY_RE.test(category)) return true;
  const title = String(card.title || "");
  if (ORTHOTIC_CARD_TITLE_RE.test(title)) return true;
  if (/\borthotics?\b/i.test(title) && !WEARABLE_FOOTWEAR_NOUN_RE.test(title)) return true;
  return false;
}

// INVARIANT detector (hard_gender_fail_open): a HARD gender request must never
// surface the OPPOSITE gender's products. Fires when the requested gender is
// men/women yet a shown card carries the other gender. Pure + testable.
export function hardGenderFailOpen({ requestedGender = null, shownCardGenders = [] } = {}) {
  const want = String(requestedGender || "").toLowerCase();
  if (want !== "men" && want !== "women") return false;
  const opposite = want === "men" ? "women" : "men";
  return (Array.isArray(shownCardGenders) ? shownCardGenders : [])
    .map((g) => String(g || "").toLowerCase())
    .some((g) => g === opposite);
}

// Does THIS message explicitly request footwear alongside orthotics? Used to
// exempt the orthotic-flow card-purity invariant — "show me shoes and orthotics"
// legitimately mixes both. A bare shoe noun that is the use-case ANSWER inside
// the guided flow ("Hoka sneakers") is NOT a request and must not exempt.
export function messageExplicitlyAsksForShoes(text = "") {
  const t = String(text || "");
  return (
    /\b(?:also|too|and|plus|with)\s+(?:some\s+)?(?:shoes?|sneakers?|sandals?|boots?|footwear)\b/i.test(t) ||
    /\b(?:show|find|recommend|want|need|looking\s+for|see|have|got|carry)\b[^.?!]*\b(?:shoes?|sneakers?|sandals?|boots?|footwear)\b/i.test(t) ||
    /\b(?:shoes?|sneakers?|sandals?|boots?|footwear)\b[^.?!]*\b(?:too|also|as\s+well)\b/i.test(t) ||
    /\bshoes?\s+(?:or|and)\s+orthotics?\b/i.test(t) ||
    /\borthotics?\s+(?:or|and)\s+shoes?\b/i.test(t)
  );
}

// Workflows whose answer comes from prior evidence / a deterministic re-pin with
// NO search this turn — the agent loop must run with tools DISABLED so the model
// can't fire a stray search whose card the deterministic owner then overwrites
// (live trace 2026-06-30: display_recovery search=false, model searched anyway).
// policy_account / customer_service / sizing_help are SUPPORT/HANDOFF turns that
// answer from knowledge with NO catalog search and MUST show no product cards. If
// the model keeps tools it fires a stray search whose card then survives the
// evidence-gated card-wipe (the wipe skips when productSearchAttempted=true) and
// leaks wedge/sandal cards onto a "how do I verify I'm a teacher?" answer (live
// trace 2026-06-30). Tools off makes the stray search impossible.
const TOOLS_OFF_WORKFLOWS = new Set([
  "clarification", "display_recovery", "product_focus", "cart_handoff",
  "policy_knowledge", "account_private_handoff",
  "policy_account", "customer_service", "sizing_help",
]);
export function workflowDisablesTools(workflow) {
  return TOOLS_OFF_WORKFLOWS.has(String(workflow || ""));
}

// SUPPORT / HANDOFF / POLICY / KNOWLEDGE workflows that must NEVER ship product
// cards. A card>0 outcome on one of these is a leak (policy_cards_leak).
const CARD_SUPPRESS_WORKFLOWS = new Set([
  "policy_knowledge", "account_private_handoff",
  "policy_account", "customer_service", "sizing_help",
]);
export function workflowSuppressesCards(workflow) {
  return CARD_SUPPRESS_WORKFLOWS.has(String(workflow || ""));
}

// ── Answer-source classes (the explicit routing this audit makes first-class) ──
// KNOWLEDGE workflows answer from RAG / static knowledge (policy, FAQ, discount,
// verification requirements, brand, technology, sizing guide) — RAG-first, never
// a product search, never product cards, support handoff ONLY when no knowledge
// answers. PRIVATE-HANDOFF workflows are private account/order/verification-
// OUTCOME issues that need a human — deterministic support CTA, no knowledge
// answer attempted. Legacy names included for back-compat.
const KNOWLEDGE_WORKFLOWS = new Set(["policy_knowledge", "policy_account"]);
const PRIVATE_HANDOFF_WORKFLOWS = new Set(["account_private_handoff", "customer_service"]);
export function isKnowledgeWorkflow(workflow) {
  return KNOWLEDGE_WORKFLOWS.has(String(workflow || ""));
}
export function isPrivateHandoffWorkflow(workflow) {
  return PRIVATE_HANDOFF_WORKFLOWS.has(String(workflow || ""));
}

// THE explicit answer-source matrix: for a workflow, which sources are allowed.
// Drives the [source-plan] log and documents the contract per requirement #2.
//   productSearch — may run a catalog/semantic product search
//   rag           — may retrieve + answer from knowledge/RAG
//   accountTool   — may call private account/order tools
//   handoff       — "no" (never) | "fallback" (only if no answer) | "primary"
//   productCards  — may show product cards
export function answerSourceMatrix(workflow) {
  const wf = String(workflow || "");
  if (isKnowledgeWorkflow(wf)) {
    return { productSearch: false, rag: true, accountTool: false, handoff: "fallback", productCards: false };
  }
  if (isPrivateHandoffWorkflow(wf)) {
    return { productSearch: false, rag: false, accountTool: true, handoff: "primary", productCards: false };
  }
  if (wf === "sizing_help") {
    return { productSearch: false, rag: true, accountTool: false, handoff: "no", productCards: false };
  }
  if (wf === "product_spec" || wf === "availability" || wf === "prior_evidence_availability") {
    return { productSearch: true, rag: false, accountTool: false, handoff: "no", productCards: true };
  }
  // All other commerce workflows: product truth first, no RAG, no handoff.
  return { productSearch: true, rag: false, accountTool: false, handoff: "no", productCards: true };
}

// ── OWNER AUTHORIZATION REGISTRY (ownership-consolidation audit, 2026-07) ─────
// TurnPlan is the ONLY workflow owner. Every deterministic owner (a gate, engine,
// pin, or handoff that produces final customer-visible text/cards) may act ONLY
// on a workflow TurnPlan assigned to it. This registry is the single source of
// truth for "which owner may claim which workflow"; chat.jsx gates each owner's
// engagement on it, and the finalize stage fires `unauthorized_owner_for_workflow`
// if the recorded owner isn't authorized for the turn's workflow.
//
// The authorized deterministic owners map to the user's allowed set:
//   availability truth   → availability-truth, variant-facts, prior-evidence
//   policy/account handoff → answer-source, support-handoff, policy-engine
//   orthotic guided flow → orthotic-gate
//   exact variant/product facts → variant-facts, product-engine
//   support CTA          → support-handoff, answer-source
//   final card/evidence alignment → scorer, evidence-plan
// Browse fallbacks (soft-browse-refine, soft-gender-browse) are demoted to
// browse/clarification only — they may not hijack a turn TurnPlan owns elsewhere.
const OWNER_WORKFLOWS = {
  "availability-truth": new Set(["availability", "prior_evidence_availability"]),
  "prior-evidence": new Set(["prior_evidence_availability"]),
  "variant-facts": new Set(["availability", "prior_evidence_availability", "product_spec"]),
  "comparison": new Set(["comparison"]),
  "evidence-plan": new Set([
    "condition_recommendation", "multi_recommendation", "compatibility",
    "named_product_advisory", "product_focus", "cart_handoff", "display_recovery", "browse",
  ]),
  "scorer": new Set(["browse", "condition_recommendation", "multi_recommendation", "sale_browse", "clarification", "named_product_advisory", "product_spec"]),
  "answer-source": new Set(["policy_knowledge", "policy_account", "account_private_handoff", "customer_service", "sizing_help"]),
  "support-handoff": new Set(["policy_knowledge", "policy_account", "account_private_handoff", "customer_service", "sizing_help"]),
  "orthotic-gate": new Set(["browse", "condition_recommendation", "clarification", "multi_recommendation", "compatibility", "sale_browse"]),
  "soft-browse-refine": new Set(["browse", "clarification"]),
  "soft-gender-browse": new Set(["browse", "clarification", "condition_recommendation"]),
  "compatibility-truth": new Set(["compatibility", "browse", "condition_recommendation", "clarification"]),
  "policy-engine": new Set(["policy_knowledge", "policy_account"]),
  "product-engine": new Set(["browse", "condition_recommendation", "multi_recommendation", "sale_browse", "named_product_advisory", "comparison", "product_focus", "product_spec", "clarification"]),
  "resolver-no-match": new Set(["browse", "condition_recommendation", "multi_recommendation", "sale_browse"]),
};
export function ownerAuthorizedForWorkflow(owner, workflow) {
  const set = OWNER_WORKFLOWS[String(owner || "")];
  if (!set) return true; // unknown/uncatalogued owner — not constrained here
  return set.has(String(workflow || ""));
}
// Owners that may legitimately act on ANY workflow regardless of assignment
// (an explicit human request or a hard validator failure is intent-driven, not
// workflow-driven) — excluded from the unauthorized-owner invariant.
const WORKFLOW_AGNOSTIC_OWNERS = new Set(["none", "llm", "scorer-empty"]);
export function isWorkflowAgnosticOwner(owner) {
  return WORKFLOW_AGNOSTIC_OWNERS.has(String(owner || ""));
}

// The single authoritative gender of a resolved NAMED family's cards, or null if
// the cards are empty or span multiple genders. A named product's catalog gender
// overrides a stale conversation gender for the turn (live trace 2026-06-30:
// women's Savannah carried a stale gender=men).
export function resolvedFamilyGender(cards = []) {
  const g = new Set(
    (Array.isArray(cards) ? cards : [])
      .map((c) => String(c?._gender || c?.gender || "").toLowerCase())
      .filter((x) => x === "men" || x === "women"),
  );
  return g.size === 1 ? [...g][0] : null;
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

// An INFORMATIONAL / hypothetical question ABOUT the return/refund/exchange
// rules — "what if I need to return them?", "what's your return policy?", "can I
// return these if they don't fit?", "are they returnable?". This is a POLICY
// answer, NOT a customer-service handoff (live trace 2026-06-30: "What if I need
// to return them?" matched the order-action pattern and got a human handoff). It
// must win over CUSTOMER_SERVICE_RE's "i need to return" action phrasing.
const POLICY_QUESTION_RE = new RegExp(
  "\\bwhat\\s+if\\b[^.?!\\n]{0,40}\\b(?:return|returns|refund|exchange|send\\s+back|don'?t\\s+fit|doesn'?t\\s+fit|too\\s+(?:small|big|tight))\\b" + "|" +
  "\\bwhat\\s+happens\\s+if\\b[^.?!\\n]{0,40}\\b(?:return|refund|exchange|don'?t\\s+fit|doesn'?t\\s+fit)\\b" + "|" +
  "\\b(?:return|refund|exchange)\\s+policy\\b" + "|" +
  "\\b(?:do\\s+you|can\\s+i|could\\s+i|am\\s+i\\s+able\\s+to)\\b[^.?!\\n]{0,30}\\b(?:return|exchange|refund)\\b[^.?!\\n]{0,30}\\b(?:if|when|in\\s+case|policy|them|it|these)\\b" + "|" +
  "\\b(?:is|are)\\s+(?:it|they|these|those)\\s+returnable\\b" + "|" +
  "\\bhow\\s+(?:do|does|long|easy)\\b[^.?!\\n]{0,25}\\b(?:return|returns|refund|exchange)\\b",
  "i",
);

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
  "\\b(?:military|veteran|teacher|student|nurse|first[-\\s]?responder|senior|healthcare|educator)\\s+discounts?\\b" + "|" +
  "\\bdo\\s+you\\s+(?:have|offer|give|do)\\b[^.?!\\n]{0,30}\\b(?:teacher|student|nurse|military|veteran|first[-\\s]?responder|senior|healthcare|educator)\\b" + "|" +
  "\\b(?:stack|combine|apply)\\s+(?:a\\s+)?(?:discount|code|coupon|promo)s?\\b" + "|" +
  "\\bdo\\s+you\\s+(?:have|offer)\\s+(?:a\\s+)?(?:promo|discount|coupon)\\b" + "|" +
  // ELIGIBILITY / VERIFICATION for a discount program — "how do I verify I'm a
  // teacher?", "what proof do I need as a student/nurse/military?". This is a
  // POLICY/account question, NOT a product recommendation. Live trace
  // 2026-06-30: "What information do I need to provide to verify I'm a teacher?"
  // matched the occupation in USECASE_RE ("teacher") → condition_recommendation
  // → 3 random wedge cards. Catch it here (PROMO_POLICY_RE runs before the
  // condition/recommend branch) so it answers from policy with no product cards.
  "\\b(?:verif\\w*|verified|prove|proof|eligib\\w*|qualify|how\\s+do\\s+i\\s+(?:get|become))\\b[^.?!\\n]{0,40}\\b(?:teacher|student|nurse|military|veteran|first[-\\s]?responder|senior|healthcare|educator|id\\.me|sheerid)\\b" + "|" +
  "\\b(?:teacher|student|nurse|military|veteran|first[-\\s]?responder|senior|healthcare|educator)\\b[^.?!\\n]{0,40}\\b(?:verif\\w*|verified|proof|eligib\\w*|qualify|discount|id\\.me|sheerid)\\b",
  "i",
);

// PRIVATE verification / application OUTCOME — "why was my teacher verification
// rejected?", "my discount application was declined", "what's the status of my
// verification?". Unlike the REQUIREMENTS question (answerable from knowledge),
// this is about THIS customer's private record and needs a human. Checked BEFORE
// PROMO_POLICY_RE so "verification" here routes to a human, not a generic answer.
const PRIVATE_VERIFICATION_RE = new RegExp(
  "\\b(?:why\\s+(?:was|were|is|did|won'?t)|what'?s?\\s+(?:the\\s+)?status\\s+of)\\b[^.?!\\n]{0,40}\\b(?:my\\s+)?(?:verification|verif\\w*|application|discount|account|eligibility)\\b" + "|" +
  "\\bmy\\b[^.?!\\n]{0,30}\\b(?:verification|application|discount|eligibility|id\\.me|sheerid)\\b[^.?!\\n]{0,25}\\b(?:reject\\w*|declin\\w*|denied|failed|not\\s+work\\w*|isn'?t\\s+work\\w*|won'?t\\s+work|pending|stuck|expired)\\b" + "|" +
  "\\b(?:reject\\w*|declin\\w*|denied|failed)\\b[^.?!\\n]{0,30}\\b(?:my\\s+)?(?:verification|application|discount\\s+(?:code|request))\\b",
  "i",
);

// PRIVATE account access / help — "can someone help me with my account?", "I
// need help with my account", "I can't get into my account". These are about
// THIS customer's account and need a human, not a knowledge answer. (Account-
// access verbs also live in CUSTOMER_SERVICE_RE, but its "help with" pattern
// misses "help me with my account" — this closes that gap.)
const ACCOUNT_ACCESS_RE = new RegExp(
  "\\b(?:help|access|issue|problem|trouble|get\\s+into|locked\\s+out\\s+of)\\b[^.?!\\n]{0,25}\\bmy\\s+account\\b" + "|" +
  "\\bmy\\s+account\\b[^.?!\\n]{0,20}\\b(?:help|access|issue|problem|locked|password|wrong)\\b" + "|" +
  "\\bcan\\s+(?:someone|anyone|you)\\s+help\\s+me\\b[^.?!\\n]{0,25}\\b(?:account|order|with\\s+my)\\b",
  "i",
);

// BRAND / TECHNOLOGY / company-info knowledge — "what is Aetrex arch support
// technology?", "tell me about your brand", "how does Lynco work?". Answerable
// from brand.txt / technology.txt, NEVER a product search. Routed to
// policy_knowledge (RAG-first, no cards unless the customer asks to shop).
const BRAND_TECH_KNOWLEDGE_RE = new RegExp(
  "\\b(?:what\\s+is|what'?s|tell\\s+me\\s+about|explain|how\\s+does|what\\s+makes|why\\s+(?:is|are)|history\\s+of|who\\s+(?:is|are|founded)|when\\s+(?:was|were))\\b[^.?!\\n]{0,40}\\b(?:technolog\\w*|arch[\\s-]support|lynco|metatarsal|memory\\s+foam|cobble|the\\s+brand|your\\s+(?:brand|company)|founded|aetrex)\\b" + "|" +
  "\\b(?:arch[\\s-]support|lynco|orthotic|cushioning)\\s+technolog\\w*\\b" + "|" +
  "\\bwhat\\s+(?:other\\s+)?technolog\\w*\\s+(?:do|does|is|are)\\b",
  "i",
);

// SIZING-GUIDE knowledge — general fit GUIDANCE ("how do Aetrex sizes usually
// fit?", "do they run true to size?", "what's the sizing like?"). Answered from
// the sizing knowledge file, NOT a per-product stock check, NOT a clarifier.
const SIZING_GUIDE_RE = new RegExp(
  "\\bhow\\s+do\\b[^.?!\\n]{0,30}\\bsizes?\\b[^.?!\\n]{0,20}\\b(?:fit|run)\\b" + "|" +
  "\\b(?:do|does)\\b[^.?!\\n]{0,30}\\b(?:run|fit)\\s+(?:true\\s+to\\s+size|small|large|big)\\b" + "|" +
  "\\b(?:sizing|fit)\\s+(?:guide|chart|advice|generally|usually|like\\b)\\b" + "|" +
  "\\bhow'?s?\\s+the\\s+sizing\\b|\\bwhat'?s?\\s+the\\s+sizing\\s+like\\b",
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
  // Lead-ins: "and in …", "how/what about …", AND the imperative refinements
  // "make it …", "change/switch (it) to …", "actually …" — a color/size pivot on
  // a product already in context ("Actually make it black" must stay availability
  // refinement, not fall to clarification/browse). Still gated to ≤5 words WITH
  // product context below, so it never steals an advisory or a plain browse.
  "\\b(?:and\\s+)?(?:in|how\\s+about|what\\s+about|make\\s+it|change\\s+(?:it\\s+)?to|switch\\s+(?:it\\s+)?to|actually)\\s+(?:an?\\s+|it\\s+in\\s+|the\\s+)?(?:" +
  "black|white|ivory|cream|navy|blue|red|burgundy|wine|maroon|pink|blush|rose|fuchsia|coral|" +
  "green|olive|sage|tan|beige|nude|taupe|khaki|brown|chocolate|cognac|camel|bronze|copper|gold|" +
  "silver|pewter|grey|gray|charcoal|slate|champagne|mauve|lavender|purple|plum|yellow|mustard|orange|" +
  "wide|narrow|\\d{1,2}(?:\\.5)?)\\b",
  "i",
);

// A PRODUCT SPEC / ATTRIBUTE question — asks for a product DATUM ("what heel
// heights do your everyday wedges come in?", "what material is the upper?",
// "are these waterproof?", "do they have a removable footbed?"). This is NOT an
// availability (in-stock yes/no) question: the availability owner answered it
// "Yes — all three are available in that." (live trace 2026-06-30), which is
// nonsense for a heel-height question. It gets its own product_spec workflow that
// answers the attribute VALUE from product facts, or honestly says the spec isn't
// listed — never "Yes, available". Color/size/width are deliberately EXCLUDED:
// those are variant-availability questions the availability owner enumerates
// correctly ("comes in Rose, Black, Denim").
const SPEC_ATTRIBUTE_NOUN =
  "heel\\s+heights?|heel\\s+drops?|platform\\s+heights?|heights?|drops?|" +
  "materials?|fabrics?|uppers?|linings?|leathers?|suedes?|" +
  "weights?|" +
  "soles?|outsoles?|midsoles?|footbeds?|traction|grip|treads?|" +
  "cushioning|toe\\s+box(?:es)?";
const SPEC_ATTRIBUTE_RE = new RegExp(
  // "what/which [kind of] <attribute> …"
  "\\bwhat(?:'?s)?\\s+(?:kind\\s+of\\s+|type\\s+of\\s+|sort\\s+of\\s+)?(?:" + SPEC_ATTRIBUTE_NOUN + ")\\b" + "|" +
  "\\bwhich\\s+(?:" + SPEC_ATTRIBUTE_NOUN + ")\\b" + "|" +
  "\\bhow\\s+(?:tall|high)\\s+(?:is|are)\\b[^.?!\\n]{0,30}\\b(?:heel|platform|wedge)\\b" + "|" +
  // boolean spec questions: "are these waterproof?", "do they have a removable footbed?"
  "\\b(?:are|is)\\s+(?:they|these|those|it|the\\s+\\w+)\\s+(?:waterproof|water[-\\s]?resistant|slip[-\\s]?resistant|non[-\\s]?slip|machine\\s+washable|vegan|orthotic[-\\s]?friendly)\\b" + "|" +
  "\\bdo\\s+(?:they|these|those|the\\s+\\w+)\\s+have\\s+(?:a\\s+)?(?:removable|built[-\\s]?in)\\s+(?:footbed|insole|orthotic|arch\\s+support)\\b" + "|" +
  "\\b(?:removable|built[-\\s]?in)\\s+(?:footbed|insole)\\b",
  "i",
);
export function isProductSpecQuestion(text) {
  return SPEC_ATTRIBUTE_RE.test(String(text || "").replace(/[‘’ʼ′＇]/g, "'"));
}

// INVARIANT detector (spec_question_answered_as_availability): a product_spec
// turn whose answer leaks availability/stock wording ("Yes, available", "in
// stock", "comes in that") instead of answering the attribute. Pure + exported.
const AVAILABILITY_WORDING_RE =
  /\b(?:yes[,\s—-]+(?:all|both|the|it|they|those|these)\b[^.?!\n]{0,30}\b(?:available|in\s+stock)|are\s+available\b|is\s+available\b|in\s+stock\b|back\s+in\s+stock\b|comes?\s+in\s+that\b|available\s+in\s+that\b)/i;
export function specQuestionAnsweredAsAvailability({ message = "", text = "" } = {}) {
  if (!isProductSpecQuestion(message)) return false;
  return AVAILABILITY_WORDING_RE.test(String(text || ""));
}

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

// Gender stated in the CURRENT message ONLY — never inherited from stale memory
// (attrs.gender). For a NAMED product the catalog gender is inherent in the
// product itself, so a stale conversation gender (e.g. a prior "men's" turn)
// must NOT filter a women's Savannah/Gabby to men's and force a fail-open
// (live trace 2026-06-30). Returns men|women|null.
function messageGender(m) {
  const male = MALE_RE.test(m), female = FEMALE_RE.test(m);
  if (male && !female) return "men";
  if (female && !male) return "women";
  return null;
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

  // 0. PRIVATE account / order / verification-OUTCOME issue — a problem with a
  // specific order, shipment, payment, account, or THIS customer's own discount
  // verification record ("why was my teacher verification rejected?") that needs
  // a HUMAN. Routed BEFORE the answerable knowledge branches so a private outcome
  // never gets a generic policy answer. No search, no cards — live-chat CTA.
  if (PRIVATE_VERIFICATION_RE.test(m) || ACCOUNT_ACCESS_RE.test(m) || (CUSTOMER_SERVICE_RE.test(m) && !POLICY_QUESTION_RE.test(m))) {
    return finalize({
      workflow: WORKFLOWS.ACCOUNT_PRIVATE_HANDOFF,
      requiredEvidence: ["policy_or_order_data"],
      searchRequired: false,
      clarificationAllowed: false,
      productDisplayPolicy: "suppress",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: null,
      directives: [
        "This is a PRIVATE customer-service issue with a specific order, shipment, delivery, payment, account, or this customer's own discount-verification record — it needs a human. Reply with ONE friendly, specific sentence acknowledging the problem and saying our customer service team can look it up and help. Do NOT search the catalog, do NOT show product cards, and do NOT invent order or account details. A live-chat button is attached for you.",
      ],
    });
  }

  // 1. Policy / FAQ knowledge — answerable from the merchant's knowledge files
  // (RAG-first), NEVER a product search and NEVER a default support handoff.
  // Covers return/refund/exchange/shipping/warranty policy questions, including
  // "are they returnable?" / "what if I need to return them?".
  if (POLICY_RE.test(m) || POLICY_QUESTION_RE.test(m)) {
    return finalize({
      workflow: WORKFLOWS.POLICY_KNOWLEDGE,
      requiredEvidence: ["knowledge_or_policy_data"],
      searchRequired: false,
      clarificationAllowed: false,
      productDisplayPolicy: "suppress",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: null,
      directives: [
        "Answer the policy/FAQ question DIRECTLY from the Relevant knowledge in your context (the merchant's knowledge files). Do NOT search the catalog or show product cards. Only suggest contacting support if the knowledge doesn't cover it.",
      ],
    });
  }

  // 1b. Promo / discount MECHANICS + discount-program VERIFICATION REQUIREMENTS
  // ("do you offer teacher discounts?", "what info do I provide to verify I'm a
  // teacher?") — answerable from the merchant's knowledge files (RAG-first),
  // never a product search. The REQUIREMENTS are knowledge; a private OUTCOME
  // ("why was MY verification rejected") was already routed to handoff in 0.
  if (PROMO_POLICY_RE.test(m)) {
    return finalize({
      workflow: WORKFLOWS.POLICY_KNOWLEDGE,
      requiredEvidence: ["knowledge_or_policy_data"],
      searchRequired: false,
      clarificationAllowed: false,
      productDisplayPolicy: "suppress",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: null,
      directives: [
        "Answer the promo/discount/verification-requirements question DIRECTLY from the Relevant knowledge in your context (FAQs / discount policy). If the knowledge covers how to qualify or verify (e.g. via SheerID/ID.me), say so. If no active code or detail exists, say codes are verified at checkout. Do NOT search the catalog or show product cards. Only suggest contacting support if the knowledge doesn't cover it.",
      ],
    });
  }

  // 1b2. BRAND / TECHNOLOGY / company info ("what is Aetrex arch support
  // technology?", "tell me about your brand") — answerable from brand.txt /
  // technology.txt (RAG-first), never a product search. Placed before the
  // condition/browse branches so an info question never becomes a product grid.
  if (BRAND_TECH_KNOWLEDGE_RE.test(m) && !hasNamed) {
    return finalize({
      workflow: WORKFLOWS.POLICY_KNOWLEDGE,
      requiredEvidence: ["knowledge_or_policy_data"],
      searchRequired: false,
      clarificationAllowed: false,
      productDisplayPolicy: "suppress",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: null,
      directives: [
        "Answer this brand/technology/company question DIRECTLY from the Relevant knowledge in your context (brand and technology files). Explain the concept clearly. Do NOT search the catalog or show product cards unless the customer explicitly asks to shop.",
      ],
    });
  }

  // 1b3. SIZING-GUIDE knowledge ("how do Aetrex sizes usually fit?", "do they run
  // true to size?") — general fit GUIDANCE answered from the sizing knowledge,
  // not a per-product stock check. No product context required; never cards.
  if (SIZING_GUIDE_RE.test(m) && !hasProductContext) {
    return finalize({
      workflow: WORKFLOWS.POLICY_KNOWLEDGE,
      requiredEvidence: ["knowledge_or_policy_data"],
      searchRequired: false,
      clarificationAllowed: false,
      productDisplayPolicy: "suppress",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: null,
      directives: [
        "Answer this general sizing/fit-guidance question DIRECTLY from the Relevant knowledge (sizing guide). Do NOT search the catalog or show product cards unless the customer names a product or category to shop.",
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

  // 1f. PRODUCT SPEC / ATTRIBUTE TRUTH — "what heel heights do your everyday
  // wedges come in?", "what material is the upper?", "are these waterproof?",
  // "do they have a removable footbed?". Asks for a product DATUM, not an
  // in-stock yes/no. Routing it to availability produced "Yes — all three are
  // available in that." (live trace 2026-06-30), which does NOT answer the
  // question. Its own deterministic workflow: search the referenced products,
  // answer the attribute VALUE from their facts, or honestly say the spec isn't
  // listed — and never assert stock. Placed BEFORE availability so the
  // "come in" / "what colors"-shaped availability regex can't steal it.
  const isSpecAttributeQuestion = isProductSpecQuestion(m);
  if (isSpecAttributeQuestion) {
    return finalize({
      workflow: WORKFLOWS.PRODUCT_SPEC,
      requiredEvidence: ["product_facts"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: hasNamed ? "show_focused" : "show",
      answerRequirements: reqs({ answerFirst: true, concise: true, answerInText: true }),
      gender: genderFor(false),
      directives: [
        "This is a PRODUCT SPEC / ATTRIBUTE question (e.g. heel height, platform height, material, outsole, removable footbed, waterproof) — NOT an availability/in-stock question. Search the styles in context and answer the actual attribute VALUE from their product facts.",
        "If the product data does not list that attribute, say so honestly and concretely — e.g. \"I don't see heel height listed for these wedge styles, but here are the wedge options I found. Aetrex support can confirm exact heel height.\" — and STILL show the relevant product cards.",
        "NEVER answer with stock/availability wording ('Yes, available', 'in stock', 'all three are available in that', 'comes in that') — that does not answer a spec question.",
      ],
    });
  }

  // 2. Availability — size / color / stock for a product in context, OR a
  // size/stock FOLLOW-UP after products were shown ("what about size 9?" with
  // prior cards). The latter has no named product in the message but is clearly
  // an availability question, so it must not fall through to clarification.
  // Force a fresh product/variant lookup; never answer from prior cards alone.
  const isDeicticAvailFollowUp = FOLLOWUP_AVAIL_RE.test(m) && words(m) <= 5;
  const isAvailFollowUpMsg = (SIZE_COLOR_STOCK_RE.test(m) || isDeicticAvailFollowUp) && !isSpecAttributeQuestion;

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
      // Allow ONE clarification only when no product could be anchored ("add to
      // cart" with several prior cards and no clear pick) — a focus product or a
      // named family both anchor the card; otherwise pin it and never ask.
      clarificationAllowed: !(focusProduct || hasNamed),
      productDisplayPolicy: "show_focused",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: genderFor(false),
      directives: [
        (focusProduct || hasNamed)
          ? "The customer wants to buy the product in focus. You can't add to cart from chat — say that briefly and point them to the product page to choose a size and add it there. KEEP the focused product's card. Do not start a new search."
          : "The customer wants to buy a product but it's unclear which one. Ask ONE short question naming the options they just saw. Do not run a new search.",
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
      // Allow ONE clarification only when the selected product couldn't be
      // anchored (an ambiguous "I like that one" with several prior cards); a
      // focus product or a named family both anchor it.
      clarificationAllowed: !(focusProduct || hasNamed),
      productDisplayPolicy: "show_focused",
      answerRequirements: reqs({ answerFirst: true, concise: true }),
      gender: genderFor(false),
      directives: [
        (focusProduct || hasNamed)
          ? "The customer just SELECTED a product they were shown. Acknowledge it in one warm line of sales copy and offer one concrete next step (check sizes/colors, or compare it with a similar style). KEEP that product's card. Do NOT run a new generic search or ask a generic clarifying question."
          : "The customer selected a product but it's unclear which one. Ask ONE short question naming the options they just saw. Do not run a new search.",
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
            "Refer to the product ONLY by the actual title and color of the card you are showing. Do NOT mention any other color — never a color from earlier in the conversation or from the customer's outfit. If you name a color, it must be the shown product's own color.",
          ]
        : [
            "Look up the named product this turn and answer the value/suitability question directly from its real facts — answer first, one honest tradeoff, then the card. Never answer a named-product question from memory alone.",
            "Refer to the product ONLY by the actual title and color of the card you are showing — never a color carried over from earlier in the conversation.",
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
  // A CATEGORY refinement ("what about sandals instead?", "boots instead",
  // "how about sneakers") after a prior shopping turn swaps the category and
  // re-runs the search, inheriting the prior gender/use-case. Never a
  // clarification (live trace 2026-06-30: "what about sandals instead?" →
  // clarification while memory had gender=men category=sandals, candidates=6).
  const CATEGORY_REFINE_RE =
    /\b(sandals?|sneakers?|boots?|booties?|loafers?|clogs?|slippers?|oxfords?|wedges?|heels?|flats?|mules?|slides?|mary\s+janes?|slip[-\s]?ons?|orthotics?|insoles?)\b/i;
  const isCategoryRefine =
    CATEGORY_REFINE_RE.test(m) && words(m) <= 6 && !hasNamed &&
    (/\b(instead|how\s+about|what\s+about|actually|rather|switch\s+to|change\s+to|try|maybe)\b/i.test(m) || words(m) <= 2);
  if (isCategoryRefine && !isGenderOnlyRefine && (hasPriorCards || hasProductContext)) {
    return finalize({
      workflow: WORKFLOWS.BROWSE,
      requiredEvidence: ["product_facts"],
      searchRequired: true,
      clarificationAllowed: false,
      productDisplayPolicy: "show",
      answerRequirements: reqs({ concise: true }),
      gender: genderFor(true),
      directives: [
        "The customer is REFINING the previous search to a DIFFERENT category. Re-run the search for the new category (inherit the prior gender/use-case from context, REPLACE the category) and SHOW the matching products. Do NOT ask a clarifying question.",
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
