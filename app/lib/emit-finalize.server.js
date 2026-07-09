// Outbound reply finalization — the single serial pipeline that runs
// between "LLM finished streaming" and "SSE text emit" in chat.jsx.
//
// EXTRACTED VERBATIM from app/routes/chat.jsx (2026-06-12) so the
// production chain is directly testable end-to-end. Before this
// extraction the chain lived inline in runAgenticLoop and the only
// integration coverage was a hand-maintained SIMULATOR
// (scripts/eval-chat-pipeline.mjs) that re-implemented the order —
// which drifted, and the 2026-06-12 dead-end-greeting escape shipped
// through the gap (banned-narration strip ate the question sentence,
// then stripUnsafeInlineChips saw "greeting + chips" and stripped the
// chips — each mutator unit-tested, the COMPOSITION untested).
//
// scripts/eval-emit-pipeline.mjs drives THIS function with recorded
// production incidents and cross-cutting invariants (never emit a
// dead-end reply; poolSize>0 ⟹ textLen>0; no internal syntax). If you
// add a mutator to the chain, it lands here and is covered for free.
//
// chat.jsx calls finalizeOutboundReply(...) once and re-imports the
// helper predicates it also uses on other paths (policy detection,
// scoped search input, llm-owns flag) — single source, no drift.

import {
  filterCatalogScopedNavigationChips,
  filterForbiddenCategoryChips,
  filterContradictingGenderChips,
  stripUnsupportedGenderChips,
  decorateGenderNavigationChips,
  narrowChipAllowListForGroup,
} from "./chip-filter.server.js";
import {
  stripBannedNarration,
  stripMetaNarration,
  dedupeConsecutiveSentences,
  ensureHeaderLineBreaks,
  reflowInlineList,
  tightenSequentialFactLines,
  truncateAtWordBoundary,
  hasChoiceButtons,
  looksLikeProductPitch,
  looksLikeDefinitionalHallucination,
  isCapabilityCheckAboutPriorProducts,
  isBrandOrInfoQuestion,
} from "./chat-helpers.server.js";
import {
  stripInternalLeaks,
  stripRawHandles,
  scrubInternalEnums,
  stripUnsafeInlineChips,
  detectRejectedCategories,
  stripRejectedCategoryChips,
  stripToolCallSyntax,
  detectStockClaim,
  stripStockClaim,
  isYesNoQuestion,
  isYesNoAnswer,
  scrubRoleMarkers,
  scrubToolCallLeaks,
  detectAiNoMatchPhrasing,
  looksLikeClarifyingQuestion,
  resolverPromisedRecommendation,
} from "./chat-postprocessing.js";
import {
  detectFalseCategoryDenial,
  detectFalseGenderCategoryAffirmation,
  extractCollectionCTA,
  extractGenericCTA,
  currentCatalogScopeFromContext,
  ensureCompleteCustomerText,
  repairProductTurnAssembly,
  buildCodeOwnedProductListingText,
  titleStyleFamily,
} from "./response-contract.server.js";
import {
  canonicalizeCatalogConstraints,
  umbrellaCategoryTermsFromGroups,
} from "./catalog-matcher.server.js";
import { extractUserConstraints } from "./catalog-resolver.server.js";
import { isPivotResetTurn, pivotSearchScopeLeak } from "./effective-scope.server.js";
// Re-export so the chat route consumes the pivot-scope boundary helpers through
// a server module it already imports (avoids adding a new direct route import).
export { isPivotResetTurn, pivotSearchScopeLeak } from "./effective-scope.server.js";
// Same boundary discipline for the broad-gender-reset + product-spec helpers:
// route them through this already-imported server module so the chat route never
// grows new direct `.server` usages the client-build DCE has to eliminate.
export { isBroadGenderReset, broadGenderFollowUpGender } from "./turn-intent.server.js";
export { workflowSuppressesCards, specQuestionAnsweredAsAvailability, answerSourceMatrix, isKnowledgeWorkflow, isPrivateHandoffWorkflow, ownerAuthorizedForWorkflow, isWorkflowAgnosticOwner, isRegisteredOwner, registeredOwnerNames } from "./turn-plan.server.js";
// Commerce Truth root-class detectors — routed through this module so the chat
// route consumes them without a new direct `.server` import.
export { productTypeMismatch, filterCardsToRequestedType, variantTextCardMismatch, cardNotInAnswerEvidence, answerAllowsAlternatives, enforceCommerceTruth } from "./commerce-truth.server.js";
import { isAnswerWorkflow, buildAnswerWorkflowExhaustionText, planForcesProductDisplay } from "./turn-plan.server.js";

// Knowledge / info questions — kept in sync with KNOWLEDGE_QUESTION_RE
// in product-turn-engine.server.js. Used to skip the response-contract
// verifier and the auto-search CTA on knowledge turns where the LLM is
// describing technologies/materials in prose; the verifier would strip
// real-but-not-cataloged feature words (e.g., "memory foam footbed"
// vs catalog footbed="bw") and leave orphan trademark fragments.
const KNOWLEDGE_QUESTION_LOCAL_RE =
  /\b(?:what\s+(?:other|else|kind\s+of|kinds\s+of|sort\s+of|sorts\s+of|type\s+of|types\s+of)\s+(?:technolog|material|feature|brand|tech|spec|fabric|sole|midsole|footbed|insole|method|system|certification)|what\s+(?:technolog|material|feature|brand|tech)|what\s+(?:is|are)\s+(?:your|the)\s+(?:technolog|material|feature|brand|tech|story|mission)|tell\s+me\s+about\s+(?:your|the|aetrex)|how\s+(?:does|do)\s+(?:your|the|biorocker|ultrasky|aetrex)|why\s+(?:aetrex|your|do\s+you)|beside[s]?\s+[A-Z][a-z]+|besides\s+[A-Z][a-z]+|other\s+than\s+[A-Z][a-z]+|explain\s+(?:your|the|biorocker|ultrasky|how)|what\s+makes\s+(?:your|aetrex|biorocker|ultrasky)|history\s+of\s+(?:aetrex|biorocker)|founded\s+(?:by|in))\b/i;
export function isKnowledgeQuestionLocal(msg) {
  return KNOWLEDGE_QUESTION_LOCAL_RE.test(String(msg || ""));
}

// Phase 4 slice — same env-flag rule as llm-owns-turn.server.js.
// When the LLM-owns path is active, the legacy in-loop mutators that
// FIGHT the model (length cap, definition-question pool wipe,
// named-product mismatch wipe, cosmetic text rewrites) are skipped:
// the grounding validator with retry supersedes them, and the live
// traces from 2026-06-10 show each of them damaging correct answers
// (compare amputated 915→295 chars; Reagan spec retried 3× against a
// guard-wiped pool; stray "-" lines from half-applied reflow).
export function llmOwnsTurnActive() {
  const raw = String(process.env.LLM_OWNS_ALL_TURNS || "").toLowerCase();
  if (raw === "false") return false;
  return true;
}

export function allowedCatalogCategoriesFromContext(ctx = {}) {
  return Array.isArray(ctx.catalogScopeCategories) ? ctx.catalogScopeCategories : [];
}

export function categoryConstraintFromText(text, catalogCategories = []) {
  const normalizedText = String(text || "").toLowerCase().replace(/[_-]+/g, " ");
  const matches = [];
  for (const raw of catalogCategories || []) {
    const display = String(raw || "").trim();
    if (!display) continue;
    const phrase = display.toLowerCase().replace(/[_-]+/g, " ");
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}(?:s|es)?\\b`, "i").test(normalizedText)) {
      matches.push(canonicalizeCatalogConstraints({ category: display }).category);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

export function productFacetConstraintsFromText(text, ctx = {}) {
  const extracted = extractUserConstraints(String(text || ""));
  const category = categoryConstraintFromText(
    text,
    ctx.fullCatalogCategories || ctx.catalogCategories || [],
  );
  if (category) extracted.category = category;
  return canonicalizeCatalogConstraints(extracted);
}

// Overlay only the DEFINED facts from the latest message onto the
// carried session scope. canonicalizeCatalogConstraints always emits
// gender/category/color keys (undefined when absent), so a naive
// object spread clobbers the carried facts with undefined on any turn
// where the customer doesn't restate them — "hi" wiped the carried
// category and context-carrying chips silently stopped decorating
// (found by eval-emit-pipeline, 2026-06-12).
export function overlayDefinedConstraints(base = {}, overlay = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

// Display noun for context-carrying gender chips, derived from the
// SAME scope the catalog-scoped chip validator uses. Data-driven:
//   - the scope's explicit category fact, when present;
//   - if that value is a merchant category-GROUP name (an umbrella
//     like "Footwear"), display the group's first trigger word
//     instead ("shoes") — group names aren't customer vocabulary;
//   - otherwise the category value lowercased, dashes → spaces.
// No scope category → empty string → no decoration.
export function genderChipCategoryNounFromContext(ctx = {}) {
  const scope = overlayDefinedConstraints(
    currentCatalogScopeFromContext(ctx),
    productFacetConstraintsFromText(ctx.latestUserMessage, ctx),
  );
  const category = String(scope.category || "").trim();
  if (!category) return "";
  const groups = Array.isArray(ctx.merchantGroups) ? ctx.merchantGroups : [];
  const group = groups.find(
    (g) => String(g?.name || "").trim().toLowerCase() === category.toLowerCase(),
  );
  if (group) {
    const triggers = (Array.isArray(group.triggers) ? group.triggers : [])
      .map((t) => String(t || "").trim().toLowerCase())
      .filter(Boolean);
    // Prefer a plural trigger — the chip reads "Men's shoes", never
    // "Men's shoe". Live 2026-06-12: the first trigger was the
    // singular "shoe" and the chips rendered "Men's shoe".
    const plural = triggers.find((t) => t.endsWith("s"));
    if (plural) return plural;
    if (triggers[0]) return `${triggers[0]}s`;
  }
  const noun = category.toLowerCase().replace(/-+/g, " ");
  // Mass nouns ending in "wear" (footwear, outerwear, activewear)
  // don't pluralize — "Men's footwears" is wrong; leave them as-is.
  if (noun.endsWith("s") || noun.endsWith("wear")) return noun;
  return `${noun}s`;
}


// Guard against denial-recovery firing on policy/discount/return
// questions where the AI's "we don't have/offer X" is a legitimate
// answer about merchant policy, NOT a hallucinated product
// availability denial. Without this guard, the customer asks
// "Can I get a discount if I buy both?" → AI politely answers
// "I don't have info on bundle discounts" → AVAILABILITY_DENIAL_RE
// matches "don't have" → recovery forces a product search and
// shows random orthotic cards under a discount question.
// "hours" only matches when shaped as business/store hours — bare
// `\bhours\b` previously caught "9 hours a day" in a product question
// ("I stand on concrete floors 9 hours a day as a nurse…"), which
// kicked the turn into the compound-policy branch and pasted a
// customer-service preamble in front of the product listing.
// "support" is intentionally NOT a top-level alternate here — it
// matches "arch support" as often as "customer support". Customer-
// support intents are caught via "support\s+team" / "contact\s+…" /
// "customer\s+service".
const POLICY_QUESTION_RE = /\b(discount|coupon|promo(?:tion)?|refund|return|exchange|warranty|guarantee|policy|polic(?:ies|y)|ship(?:ping|ment)?|deliver(?:y|ies)?|bundle|payment|installment|(?:store|business|operating|opening|closing|service)\s+hours|hours\s+(?:of\s+operation|today|open|closed)|track(?:ing)?|order (?:status|number|history)|account|sign\s*in|log\s*in|coupon|support\s+team|contact\s+(?:you|your|support|us|customer)|customer\s+service|gov\s*x|teacher\s+discount|military\s+discount|first\s+responder|nurse\s+discount|student\s+discount|senior\s+discount)\b/i;
export function isPolicyOrServiceQuestion(text) {
  return Boolean(text) && POLICY_QUESTION_RE.test(text);
}

const PRODUCT_SHOPPING_NOUN_RE = /\b(shoes?|footwear|sneakers?|sandals?|boots?|loafers?|clogs?|wedges?|heels?|orthotics?|insoles?|footbeds?|inserts?|slippers?|oxfords?|mary\s+janes?|slip[-\s]?ons?|accessor(?:y|ies)|slides?|flats?|mules?|styles?|pairs?)\b/i;
const SHOPPING_ACTION_RE = /\b(show|find|have|carry|sell|stock|looking\s+for|look\s+for|need|want|recommend|browse|shop|any|options?|styles?)\b/i;
const COMPOUND_JOINER_RE = /\b(?:and|also|plus|while|then|too|as\s+well)\b|[,;]\s*(?:and|also|plus)?\s*/i;

export function hasCompoundProductAsk(text) {
  const value = String(text || "");
  if (!PRODUCT_SHOPPING_NOUN_RE.test(value)) return false;
  if (SHOPPING_ACTION_RE.test(value)) return true;
  return /\b(?:and|also|plus|too|as\s+well)\b[^?!.]{0,80}\b(shoes?|footwear|sneakers?|sandals?|boots?|loafers?|clogs?|wedges?|heels?|orthotics?|insoles?|slippers?|styles?|pairs?)\b/i.test(value);
}

export function isCompoundPolicyProductQuestion(text) {
  if (!isPolicyOrServiceQuestion(text)) return false;
  const value = String(text || "");
  if (!hasCompoundProductAsk(value)) return false;
  return COMPOUND_JOINER_RE.test(value);
}

export function scopedProductSearchInput(ctx = {}) {
  const latestMsg = String(ctx.latestUserMessage || "");
  // PIVOT/RESET turns are CURRENT-MESSAGE-ONLY: drop the inherited session/
  // resolver scope entirely so stale category/condition/use-case can't ride
  // into the forced query (live trace: "show me shoes instead, not orthotics"
  // → query="women's sneakers walking"). Stable gender still falls back below.
  const pivot = ctx.turnScope === "new_independent" || isPivotResetTurn(latestMsg);
  const scope = pivot ? {} : currentCatalogScopeFromContext(ctx);
  const latest = extractUserConstraints(latestMsg);
  const gender = scope.gender || latest.gender || (pivot ? ctx.sessionGender : null) || undefined;
  const category = scope.category || latest.category;
  const color = scope.color || latest.color;
  // MEMORY HYGIENE: size/width are variant-level constraints from a prior
  // availability turn. They must NOT silently filter a later browse/condition/
  // comparison search — only honor them when the LATEST message restates one.
  // (Availability turns resolve size/width on their own deterministic path.)
  const size = latest.size || null;
  const width = latest.width || null;
  const condition = scope.condition || latest.condition;
  const filters = {};
  if (gender) filters.gender = gender;
  if (category) filters.category = category;
  if (color) filters.color = color;
  if (size) filters.size = size;
  if (width) filters.width = width;

  // Sale browse: search DISCOUNTED products. Set onSale + a clean query
  // (category or "sale") — NEVER the raw sentence ("Show me current sales and
  // promotions"), which returns garbage. Honor a price cap if present.
  const saleIntent =
    ctx?.turnPlan?.workflow === "sale_browse" ||
    /\b(on\s+sale|what'?s\s+on\s+sale|clearance|markdown[s]?|discount(?:ed)?|deal[s]?)\b/i.test(latestMsg);
  const priceCap = latestMsg.match(/\b(?:under|below|less\s+than|up\s+to)\s+\$?\s*(\d{2,4})\b/i);

  const input = { filters, limit: 6 };
  if (saleIntent) {
    input.onSale = true;
    filters.onSale = true;
    input.query = [color, category].filter(Boolean).join(" ").trim() || "sale";
  } else {
    input.query = [color, condition, category].filter(Boolean).join(" ").trim() || latestMsg.slice(0, 160).trim() || "shoes";
  }
  if (priceCap) {
    const max = Number(priceCap[1]);
    if (Number.isFinite(max)) { input.priceMax = max; filters.priceMax = max; }
  }

  return {
    input,
    scope: { gender, category, color, size, width, condition, onSale: saleIntent || undefined, priceMax: priceCap ? Number(priceCap[1]) : undefined },
  };
}

// Answer-workflow forced search — current-turn evidence only, NO stale memory.
//
// The default scopedProductSearchInput pulls category/color/size from session
// memory FIRST (`scope.X || latest.X`), which is exactly how a Disney/sneakers
// turn contaminated a later "Do you have Savannah in champagne?" availability
// turn into query="sneakers". For answer workflows we build the forced/fallback
// search from (a) the model's first plan-enforced family search this turn —
// captured as `capturedInput`, whose query already names the family — falling
// back to (b) the latest customer message text, plus constraints extracted
// ONLY from the latest message. The named family owns the query; it can never
// become "sneakers". Variant filters (size/width) are dropped so the FAMILY
// card still surfaces when the exact variant isn't in stock (the precise
// availability is answered in TEXT); gender comes from the plan when stated.
export function buildAnswerWorkflowForcedSearch({ ctx = {}, capturedInput = null } = {}) {
  const latestMsg = String(ctx.latestUserMessage || "");
  const latest = extractUserConstraints(latestMsg);
  const plan = ctx.turnPlan || {};

  const filters = {};
  const gender = plan.gender === "men" || plan.gender === "women" ? plan.gender : latest.gender;
  if (gender) filters.gender = gender;
  // Color is a real, ensureProductTurnCards-relaxable variant filter — keep it
  // only when the LATEST message named it. Size/width are intentionally NOT
  // applied to the card search (they'd empty the family); the model answers
  // them in text and the customer checks the card.
  if (latest.color) filters.color = latest.color;

  const capturedQuery = capturedInput?.query ? String(capturedInput.query).trim() : "";
  let query;
  let category = null;
  if (capturedQuery) {
    // Family-named workflow (comparison / named-product advisory): the captured
    // family search owns the query — it already names the family.
    query = capturedQuery;
  } else {
    // Condition / advisory with NO named family: build a STRUCTURED query from
    // the LATEST message's constraints — support + style adjective + use-case +
    // condition + category — instead of raw-querying the whole sentence. e.g.
    // "I need supportive sandals for vacation walking, but cute" →
    // "supportive cute walking sandals", category=sandals. Apply the category
    // as a real filter (the log showed category=- because it never was).
    const support = /\b(supportive|support|arch\s*support|cushion(?:ed|ing)?|stability|orthopedic|comfort(?:able)?)\b/i.test(latestMsg) ? "supportive" : "";
    const styleMatch = latestMsg.match(/\b(cute|stylish|dressy|elegant|chic|pretty|fashionable|sporty|casual|sleek|classy|trendy)\b/i);
    const style = styleMatch ? styleMatch[1].toLowerCase() : "";
    const structuredQuery = [support, style, latest.useCase, latest.condition, latest.category]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (latest.category) { category = latest.category; filters.category = latest.category; }
    query = structuredQuery || latestMsg.slice(0, 160).trim() || "shoes";
  }

  return {
    input: { query, filters, limit: 6 },
    scope: { gender, category, color: latest.color, useCase: latest.useCase || null },
  };
}

// Family token from a free-text search query (e.g. the captured evidence
// query "Savannah adjustable quarter strap sandal" → "savannah").
export function familyFromQuery(query) {
  return titleStyleFamily(String(query || "")).toLowerCase();
}

function escapeReLocal(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── alignCardsToAnswerText ──────────────────────────────────────────
// Product/text alignment validator (answer workflows). Text and cards MUST
// come from the SAME current-turn evidence pool. If the answer text names a
// product family (the one the model searched, or a family present in the turn
// evidence) but the DISPLAYED cards are a DIFFERENT family, those cards are
// stale-memory contamination — e.g. text "The Savannah comes in Champagne"
// while the cards are Danika/Kinsley/Carly sneakers. Recover the named family
// from the evidence pool when we have it; otherwise suppress the mismatched
// cards so the answer stands alone (never show the wrong product).
//
// Conservative: only acts when a SPECIFIC family is referenced. A generic
// condition_recommendation answer naming no product is left untouched.
//
// RECOVER BEFORE SUPPRESS: when the cards don't represent a referenced family,
// recover that family from the turn evidence and PREPEND it. For advisory/
// comparison/condition (keepAlternatives), the original cards follow as
// relevant alternatives; for availability (show only the named product) the
// recovered family replaces them. Suppression is the last resort, only when
// the referenced family can't be surfaced from the evidence at all.
//
// Returns { cards, changed, reason }.
export function alignCardsToAnswerText({ text = "", cards = [], evidencePool = [], namedFamilyHint = "", namedFamilies = [], keepAlternatives = false, cap = 6 } = {}) {
  if (!Array.isArray(cards) || cards.length === 0) return { cards, changed: false, reason: "no-cards" };
  const lc = String(text || "").toLowerCase();
  if (!lc.trim()) return { cards, changed: false, reason: "no-text" };

  const familyOf = (c) => titleStyleFamily(String(c?.title || "")).toLowerCase();
  const inText = (fam) => Boolean(fam) && fam.length >= 4 && new RegExp(`\\b${escapeReLocal(fam)}\\b`).test(lc);
  const named = (namedFamilies || []).map((s) => String(s || "").toLowerCase()).filter((s) => s.length >= 4);

  // Availability (keepAlternatives=false) with named families: the visible
  // cards must be ONLY the named product family. An exact-availability check
  // ("Do you have Savannah in champagne?") must never show Romy/Danika
  // alternatives alongside the Savannah — drop them even when Savannah is
  // already present.
  if (!keepAlternatives && named.length > 0) {
    const namedSet = new Set(named);
    const only = cards.filter((c) => namedSet.has(familyOf(c)));
    if (only.length > 0) {
      return only.length < cards.length
        ? { cards: only.slice(0, cap), changed: true, reason: "restricted-to-named" }
        : { cards, changed: false, reason: "aligned" };
    }
    const recovered = (evidencePool || []).filter((c) => namedSet.has(familyOf(c)));
    if (recovered.length > 0) return { cards: recovered.slice(0, cap), changed: true, reason: "recovered-replace" };
    return { cards: [], changed: true, reason: "suppressed-mismatch" };
  }

  // Advisory/comparison/condition: families this turn references = the named
  // families ∪ the captured-search hint ∪ any evidence family named in the text.
  const referenced = new Set([...named, String(namedFamilyHint || "").toLowerCase()].filter((s) => s.length >= 4));
  for (const c of evidencePool || []) {
    const f = familyOf(c);
    if (inText(f)) referenced.add(f);
  }
  if (referenced.size === 0) return { cards, changed: false, reason: "text-names-no-family" };

  // Aligned: a displayed card already belongs to a referenced family.
  if (cards.map(familyOf).some((f) => referenced.has(f))) return { cards, changed: false, reason: "aligned" };

  // Mismatch. Recover referenced-family cards from the evidence and prepend
  // them; the alternatives follow.
  const recovered = (evidencePool || []).filter((c) => referenced.has(familyOf(c)));
  if (recovered.length > 0) {
    const seen = new Set();
    const merged = [];
    for (const c of [...recovered, ...cards]) {
      const key = String(c?.handle || c?.title || "").toLowerCase();
      if (key && !seen.has(key)) { seen.add(key); merged.push(c); }
    }
    return { cards: merged.slice(0, cap), changed: true, reason: "recovered-prepend" };
  }
  return { cards: [], changed: true, reason: "suppressed-mismatch" };
}

export function compoundPolicyFallbackText(latestMessage = "") {
  const latest = String(latestMessage || "");
  if (/\b(discount|coupon|promo(?:tion)?\s*code|promo(?:tion)?|coupon\s*code|bundle)\b/i.test(latest)) {
    return "For discounts or promo codes, use the current offer shown on Aetrex.com or at checkout; I won't invent a code if one isn't verified.";
  }
  if (/\b(rewards?|loyalty|points?|vip|referral)\b/i.test(latest)) {
    return "For rewards, logged-in customers can view their points, VIP perks, and available rewards in their Aetrex account.";
  }
  if (/\b(return|returns|refund|exchange|exchanges)\b/i.test(latest)) {
    return "For returns, Aetrex accepts unworn items in original packaging within 30 days of delivery.";
  }
  if (/\b(ship|shipping|delivery)\b/i.test(latest)) {
    return "For shipping, the current delivery details are handled through the support and checkout flow.";
  }
  if (/\b(warranty|guarantee)\b/i.test(latest)) {
    return "For warranty questions, Aetrex support can help confirm the policy for your item.";
  }
  if (/\b(track|tracking|order\s+(?:status|number|history)|where\s+is\s+my\s+order)\b/i.test(latest)) {
    return "For order tracking, use your tracking email or the support link so Aetrex can look up the order directly.";
  }
  // "support" alone matches "arch support" in product questions —
  // require customer-support shape (customer service / support team /
  // contact us / account help) so the compound branch doesn't paste
  // a service preamble in front of a product turn.
  if (/\b(?:customer\s+(?:service|support)|support\s+team|contact\s+(?:you|your|support|us|customer)|account|log\s*in|sign\s*in|help\s+desk|reach\s+(?:out|customer))\b/i.test(latest)) {
    return "For account or support questions, use the support link to contact Aetrex customer service.";
  }
  return "For the service question, the support page has the current Aetrex details.";
}

export function compoundPolicyClausePresent(text = "", latestMessage = "") {
  const visible = String(text || "");
  const latest = String(latestMessage || "");
  if (!visible.trim()) return false;

  if (/\b(discount|coupon|promo(?:tion)?\s*code|promo(?:tion)?|coupon\s*code|bundle)\b/i.test(latest)) {
    return /\b(discount|coupon|promo|code|checkout|offer)\b/i.test(visible);
  }
  if (/\b(rewards?|loyalty|points?|vip|referral)\b/i.test(latest)) {
    return /\b(rewards?|loyalty|points?|vip|referral|account)\b/i.test(visible);
  }
  if (/\b(return|returns|refund|exchange|exchanges)\b/i.test(latest)) {
    return /\b(return|returns|refund|exchange|30\s+days?|unworn|packaging)\b/i.test(visible);
  }
  if (/\b(ship|shipping|delivery)\b/i.test(latest)) {
    return /\b(ship|shipping|delivery|checkout|support|tracking)\b/i.test(visible);
  }
  if (/\b(warranty|guarantee)\b/i.test(latest)) {
    return /\b(warranty|guarantee|coverage|support)\b/i.test(visible);
  }
  if (/\b(track|tracking|order\s+(?:status|number|history)|where\s+is\s+my\s+order)\b/i.test(latest)) {
    return /\b(track|tracking|order|email|support)\b/i.test(visible);
  }
  if (/\b(?:customer\s+(?:service|support)|support\s+team|contact\s+(?:you|your|support|us|customer)|account|log\s*in|sign\s*in|help\s+desk|reach\s+(?:out|customer))\b/i.test(latest)) {
    return /\b(support|customer service|contact|account)\b/i.test(visible);
  }
  return /\b(support|service|policy|details)\b/i.test(visible);
}

export function ensureCompoundPolicyClause(text = "", ctx = {}) {
  const latest = ctx?.latestUserMessage || "";
  if (!isCompoundPolicyProductQuestion(latest)) return { text, changed: false };
  const fallback = compoundPolicyFallbackText(latest);
  if (!fallback || compoundPolicyClausePresent(text, latest)) {
    return { text, changed: false };
  }
  const trimmed = String(text || "").trim();
  return {
    text: trimmed ? `${fallback} ${trimmed}` : fallback,
    changed: true,
  };
}

export function policyOnlyFallbackText(latestMessage = "") {
  const latest = String(latestMessage || "");
  if (/\b(discount|coupon|promo(?:tion)?|code|deal|sale|clearance|markdown|bundle)\b/i.test(latest)) {
    return "I can't verify a specific active promo code here. Use the current offer shown on Aetrex.com or at checkout, and avoid any code that is not listed by Aetrex.";
  }
  if (/\b(rewards?|loyalty|points?|vip|referral)\b/i.test(latest)) {
    return "Aetrex Rewards details are available in the customer's logged-in account, including points, VIP perks, referrals, and redeemable rewards when configured.";
  }
  if (/\b(return|returns|refund|exchange|exchanges)\b/i.test(latest)) {
    return "Aetrex's return policy accepts unworn items in original packaging within 30 days of delivery. Refunds are issued to the original payment method within 5-7 business days after the return is received.";
  }
  if (/\b(ship|shipping|delivery)\b/i.test(latest)) {
    return "For shipping and delivery questions, the latest order-specific details are available through the support link below or your order tracking email.";
  }
  if (/\b(warranty|guarantee)\b/i.test(latest)) {
    return "For warranty questions, Aetrex support can help confirm coverage for your item. Use the support link below and include your order details if you have them.";
  }
  if (/\b(track|tracking|order\s+(?:status|number|history)|where\s+is\s+my\s+order)\b/i.test(latest)) {
    return "For order status or tracking, use your tracking email or the support link below so Aetrex can look up the order directly.";
  }
  if (/\b(?:customer\s+(?:service|support)|support\s+team|contact\s+(?:you|your|support|us|customer)|account|log\s*in|sign\s*in|help\s+desk|reach\s+(?:out|customer))\b/i.test(latest)) {
    return "Aetrex support can help with account and order questions. Use the support link below to contact customer service.";
  }
  return "";
}

export function compoundProductFallbackText(ctx = {}) {
  const { scope } = scopedProductSearchInput(ctx);
  const category = scope.category ? String(scope.category).replace(/-/g, " ") : "styles";
  const gender = scope.gender === "men" ? "men's " : scope.gender === "women" ? "women's " : "";
  return `I also found the closest ${gender}${category} below.`;
}

// Raw tool-call control tokens that must never reach the customer.
// Used twice: as the first cleanup step (before scrubInternalEnums can
// rewrite the snake_case tool names) and in the later belt-and-
// suspenders strip block.
const TOOL_SYNTAX_LEAK_RE = /(?:<\/?(?:function_calls|invoke|antml|parameter)|\b(?:search_products|get_product_details|lookup_sku|find_similar_products|recommend_[a-z_]+)\s*\{)/i;

// Trim an ORPHANED trailing connector left behind after narration
// stripping. The model often writes "<answer>. Now, let me pull the
// review data…" — banned-narration removes "let me pull…" but leaves a
// dangling "Now," so the reply ends mid-thought ("…several miles a day.
// Now"). Prod trace 2026-06-24 (Jillian sandal). Only strips a connector
// that sits AFTER sentence-ending punctuation (so a real final word like
// "Shop now." is never touched), then restores clean end punctuation.
const DANGLING_CONNECTOR_RE =
  /([.!?])\s+(?:Now|So|Then|Also|Plus|And|But|Alright|All right|Okay|OK|Well|Anyway|Anyhow|First|Next|Finally|Here['‘’]s|Here is)[\s,;:—–-]*$/i;
function trimDanglingConnector(text) {
  if (!text) return text;
  let out = text;
  while (DANGLING_CONNECTOR_RE.test(out)) {
    out = out.replace(DANGLING_CONNECTOR_RE, "$1").trimEnd();
  }
  return out;
}

// The finalize chain. Body moved VERBATIM from chat.jsx runAgenticLoop
// (post-LLM section). `pool` may be truncated (suppressions) or
// replaced; callers must adopt the returned pool. `qualitySignals` is
// mutated in place (same object the caller logs). Returns the final
// customer-visible text plus the generic CTA extracted from it.
export function finalizeOutboundReply({
  text,
  pool: poolIn,
  ctx = {},
  toolsCalledThisTurn = new Set(),
  supportCTA = null,
  recommenderAskedForMoreInfo = false,
  productSearchAttempted = false,
  qualitySignals = {},
}) {
  let fullResponseText = text;
  let pool = Array.isArray(poolIn) ? poolIn : [];

  // Set when the cleanup pipeline below strips a substantial reply down
  // to a near-empty fragment (e.g. the model's whole turn was a "Let me
  // pull the review data…" announcement → banned-narration scrubs it to
  // 3 chars). The fully-empty repair downstream only fires on "" — a
  // tiny non-empty fragment slips past it and ships cards with no answer
  // (prod trace 2026-06-24, Jillian sandal durability question). This
  // flag lets that repair treat the fragment as empty.
  let strippedNarrationToFragment = false;

  if (fullResponseText) {
    // Always-on text cleanup pipeline. Six independent mutators that
    // run unconditionally after every LLM turn — none gate the next,
    // none conflict with each other, all are about removing speech
    // patterns we don't want surfaced. Consolidated into one block
    // with a single summary log so future regressions are easy to
    // diagnose. ORDER MATTERS only in that meta-narration removal
    // happens after banned-narration removal (banned is more specific).
    const cleanupSteps = [
      // Tool-call syntax MUST be scrubbed before scrubInternalEnums:
      // the enum humanizer rewrites snake_case tokens ("search_products"
      // → "Search products"), after which the tool-syntax detector
      // downstream no longer recognizes the leak and the raw JSON args
      // reach the customer (found by eval-emit-pipeline, 2026-06-12).
      {
        fn: (t) => (TOOL_SYNTAX_LEAK_RE.test(t) ? stripToolCallSyntax(t) : t),
        name: "tool-syntax",
      },
      { fn: stripInternalLeaks,            name: "internal-leak" },
      { fn: scrubInternalEnums,            name: "internal-enum" },
      { fn: stripBannedNarration,          name: "banned-narration" },
      { fn: stripMetaNarration,            name: "meta-narration" },
      { fn: dedupeConsecutiveSentences,    name: "dedupe" },
      // header-breaks runs on BOTH paths: its sole job is putting
      // bold product/section headers on their own paragraph, and the
      // very first LLM-owns compare without it glued "**Jillian
      // Braided Quarter Strap Sandal — $139.95**" onto the tail of
      // the Vicki section (screenshot 2026-06-10). It's the best-
      // tested mutator here (bullet/heading/tech-name guards) and is
      // shape-preserving. reflow-list and tighten-facts stay
      // legacy-only — they were implicated in the orphan "-" lines.
      { fn: ensureHeaderLineBreaks,        name: "header-breaks" },
      ...(llmOwnsTurnActive() ? [] : [
        { fn: reflowInlineList,              name: "reflow-list" },
        { fn: tightenSequentialFactLines,    name: "tighten-facts" },
      ]),
      // LAST — clean up an orphaned trailing connector ("…day. Now") that
      // an earlier narration strip may have left dangling. Runs after all
      // shape mutators so it sees the final text.
      { fn: trimDanglingConnector,         name: "dangling-connector" },
      // ABSOLUTE LAST — emit guard: a raw product handle/slug must never
      // reach the customer, even if validator retries didn't clean it.
      // Runs after every other strip so it catches a handle a prior step
      // may have left exposed (live trace 2026-06-25: a draft cleaned down
      // to "Jillian-cork-sc364w jillian-cork-sc364w").
      { fn: (t) => stripRawHandles(t, pool), name: "raw-handle" },
    ];
    const preCleanupText = fullResponseText;
    const cleanupLogs = [];
    for (const step of cleanupSteps) {
      const before = fullResponseText;
      const result = step.fn(before);
      // Steps return either a string or { text, changed } — normalize.
      const next = typeof result === "string" ? result : result?.text ?? before;
      const changed = typeof result === "string"
        ? next.trim() !== before.trim()
        : Boolean(result?.changed);
      if (changed && next != null) {
        cleanupLogs.push(step.name);
        fullResponseText = next;
      }
    }
    if (cleanupLogs.length > 0) {
      console.log(`[chat] cleanup pipeline: ${cleanupLogs.join("+")}`);
    }
    // Did a narration/leak scrub gut a real answer down to a fragment?
    // Only flag when we removed a substantial chunk (≥40 chars in) and
    // what's left is essentially nothing (<12 chars) — a normal short
    // reply ("Take a look!") never trips this because nothing was stripped.
    const narrationStripFired = cleanupLogs.some(
      (n) => n === "internal-leak" || n === "banned-narration" || n === "meta-narration" || n === "tool-syntax",
    );
    if (
      narrationStripFired &&
      preCleanupText.trim().length >= 40 &&
      fullResponseText.trim().length < 12
    ) {
      strippedNarrationToFragment = true;
    }
    // The handle emit guard can empty a handle-only reply regardless of the
    // pre-cleanup length (the bad draft may itself have been short). Whenever
    // stripping a raw handle leaves a fragment, force the pool fallback so we
    // never ship a bare/empty bubble in place of the slug.
    if (cleanupLogs.includes("raw-handle") && fullResponseText.trim().length < 12) {
      strippedNarrationToFragment = true;
    }
  }

  const PRODUCT_REPLY_HARD_CAP = 300;
  // Review / fit / return / comparison answers are LONG by nature
  // (review quotes, fit summary, multi-feature compare). The 300-char
  // cap chops them to a useless one-liner preamble. Live trace:
  // "What do customers say about Maui?" → LLM wrote 685 chars of real
  // review content, cap chopped to 63 chars → emitted "Here's what
  // customers are saying about the Maui Orthotic Flips." with nothing
  // after it. Same for "BioRocker vs UltraSky" tech compare.
  const REVIEW_FIT_RETURN_OR_COMPARE_RE =
    /\b(?:review|reviews|rated|rating|ratings|reviewed|star|stars|score|popular|best[- ]?selling|bestseller|customer[s']*\s+(?:say|saying|love|favor)|what\s+(?:do\s+)?(?:people|customers|buyers|others)\s+(?:say|think)|return|returns|refund|refunds|exchange|exchanges|run|runs|fit|fits|true\s+to\s+size|size\s+up|size\s+down|compare|comparison|vs\.?|versus|difference\s+between|cheap|cheapest|cheaper|expensive|price|priced|cost|costs|how\s+much|under\s+\$?\d+|points?\s+(?:need|i\s+need|to\s+(?:buy|get|redeem))|for\s+free|technolog|material|feature|brand|tech\b|spec|fabric|midsole|footbed|insole|method|system|certification|story|mission|history|founded|beside|besides|other\s+than|explain|what\s+makes)\b/i;
  // LLM-owns: never hard-cap. Live trace 2026-06-10: "which is
  // better, Vicki or Jillian?" → model wrote a 915-char structured
  // compare; cap chopped to 295 mid-word leaving "**Jillian Braided
  // Quarter…" dangling on screen. Brevity is a prompt rule now, not
  // a post-hoc scissors.
  const skipHardCap =
    llmOwnsTurnActive() ||
    REVIEW_FIT_RETURN_OR_COMPARE_RE.test(String(ctx?.latestUserMessage || ""));
  if (
    !skipHardCap &&
    pool.length > 0 &&
    fullResponseText &&
    fullResponseText.length > PRODUCT_REPLY_HARD_CAP &&
    !hasChoiceButtons(fullResponseText)
  ) {
    let truncated = truncateAtWordBoundary(fullResponseText, PRODUCT_REPLY_HARD_CAP, 400);
    const lineStartListRe = /(?:\n|^)\s*(?:[-*]\s+\*?\*?|\d+[.)]\s+|\*\*[A-Z])/;
    const inlineListRe = /(?::\s*[-*]\s+\*\*|:\s+\*\*[A-Z]|—\s*\*\*[A-Z])/;
    const lineStartIdx = truncated.search(lineStartListRe);
    const inlineIdx = truncated.search(inlineListRe);
    const candidates = [lineStartIdx, inlineIdx].filter((i) => i >= 0);
    const listStart = candidates.length > 0 ? Math.min(...candidates) : -1;
    if (listStart >= 0) {
      const head = truncated.slice(0, listStart).trimEnd();
      const cleaned = head.replace(/[\s,;:—–-]+$/, "").replace(/\s+(top picks|here are|a few|some options|the picks|the options)\s*$/i, "").trim();
      if (cleaned.length >= 30) {
        truncated = cleaned.endsWith(".") || cleaned.endsWith("!") || cleaned.endsWith("?") ? cleaned : cleaned + ".";
      }
    }
    if (truncated.length < fullResponseText.length) {
      console.log(`[legacy-cov] path=finalize-hard-cap gate=!llmOwnsTurnActive`);
      console.log(`[chat] response-length cap: ${fullResponseText.length} → ${truncated.length} chars (pool=${pool.length})`);
      fullResponseText = truncated;
    }
  }

  // Legacy-only: under llm-owns the model's text stands — live trace
  // 2026-06-10: a RAG-grounded return-policy answer (444 chars) matched
  // the pitch regex, got wiped to "", and the fallback chain replaced
  // it with a canned support line. The grounding validator polices
  // product claims; policy/info prose is the model's to write.
  if (
    !llmOwnsTurnActive() &&
    pool.length === 0 &&
    looksLikeProductPitch(fullResponseText) &&
    !looksLikeClarifyingQuestion(fullResponseText) &&
    !recommenderAskedForMoreInfo &&
    !isBrandOrInfoQuestion(ctx.latestUserMessage) &&
    !resolverPromisedRecommendation(ctx.resolverState)
  ) {
    console.log(`[legacy-cov] path=finalize-empty-pool-pitch-wipe gate=!llmOwnsTurnActive`);
    console.log(`[chat] empty-pool repair: pitch text without products (searchAttempted=${productSearchAttempted})`);
    fullResponseText = "";
  }

  // Definitional hallucination check. If the AI tried a search,
  // got nothing, but then confidently defines an unknown brand/line
  // ("Lynco is our premium orthotic line that…"), strip the response.
  // Forces the AI to ask a clarifying question on the next turn.
  if (
    productSearchAttempted &&
    pool.length === 0 &&
    !recommenderAskedForMoreInfo &&
    looksLikeDefinitionalHallucination(fullResponseText)
  ) {
    console.log(`[chat] empty-pool repair: definitional hallucination`);
    qualitySignals.definitionalHallucination = true;
    fullResponseText = "";
  }

  // False category-denial guard. The AI sometimes claims the store
  // doesn't carry a category that's actually in the synced catalog
  // (e.g. "this store carries orthotics (not shoes)" when shoes are
  // a real product type). The STORE FACTS section of the prompt
  // forbids this, but the LLM can still slip — especially with
  // parenthetical exclusions like "(not shoes)" that read past the
  // existing AVAILABILITY_DENIAL_RE. Catch it here, strip the
  // response, and let the empty-text fallback render a neutral
  // recovery message that doesn't mislead the customer.
  const fullCats = Array.isArray(ctx.fullCatalogCategories) ? ctx.fullCatalogCategories : [];
  if (fullCats.length > 0 && fullResponseText) {
    const deniedCat = detectFalseCategoryDenial(fullResponseText, fullCats);
    if (deniedCat) {
      console.log(`[chat] false-denial guard: AI claimed the store doesn't carry "${deniedCat}" — stripping (catalog actually contains it)`);
      qualitySignals.falseDenial = true;
      // Answer workflows are owed a real, evidence-grounded answer — never the
      // generic "take a look" browse pitch. When the plan is an answer workflow
      // and we have a pool, name the actual products (exhaustion text) instead of
      // generic browse copy; only non-answer turns get the lighter recovery line.
      if (pool.length > 0) {
        fullResponseText = isAnswerWorkflow(ctx.turnPlan)
          ? buildAnswerWorkflowExhaustionText(ctx.turnPlan, pool)
          : `Take a look — here are some ${deniedCat.toLowerCase()} we carry.`;
      } else {
        fullResponseText = `We do carry ${deniedCat.toLowerCase()} — could you share a bit more (gender, style, occasion)? I can pull up a few for you.`;
      }
    }
  }

  if (!fullResponseText && pool.length === 0) {
    // Resolver fulfillment invariant: if the resolver had a
    // recommend verdict with candidates, NEVER claim "nothing's
    // hitting" — that contradicts the catalog-grounded verdict.
    // Soften to a clarifying ask instead.
    if (resolverPromisedRecommendation(ctx.resolverState)) {
      console.log(`[chat] empty-text repair: resolver had recommend+candidates but hydration failed — using soft clarification`);
      fullResponseText = "Tell me a bit more about what you need — condition, use-case, anything — and I'll narrow it down.";
    } else {
      // Neutral clarification line. Avoid "budget" and "combination"
      // unless the customer actually said either — false claims about
      // their own constraints irritate.
      fullResponseText = "Tell me a bit more — color, style, or what you're using them for — and I'll narrow it down.";
    }
  } else if (pool.length > 0 && (!fullResponseText || strippedNarrationToFragment)) {
    // Strips wiped the entire text — or gutted it to a useless fragment
    // (e.g. the AI's only output was "Let me pull the real review data…"
    // → banned-narration scrubbed it to 3 chars) — but a search returned
    // products. Without a fallback we'd ship an empty/near-empty bubble
    // above the cards and the customer's question goes unanswered.
    console.log(
      `[chat] empty-text repair: text ${fullResponseText ? "gutted to fragment" : "wiped"} by strips, pool=${pool.length}`,
    );
    qualitySignals.emptyAfterStrips = true;
    // Answer workflows are owed a real answer — never the generic "take a
    // look" pitch. Use the honest, evidence-grounded line (names the products,
    // states the situation). The grounding validator + retry get a chance to
    // produce a true synthesized answer; this is the floor if they can't.
    fullResponseText = isAnswerWorkflow(ctx.turnPlan)
      ? buildAnswerWorkflowExhaustionText(ctx.turnPlan, pool)
      : "Take a look — these are the closest matches I've got.";
  }

  if (
    !llmOwnsTurnActive() &&
    isPolicyOrServiceQuestion(ctx.latestUserMessage) &&
    !isCompoundPolicyProductQuestion(ctx.latestUserMessage) &&
    !PRODUCT_SHOPPING_NOUN_RE.test(String(ctx.latestUserMessage || ""))
  ) {
    const policyFallback = policyOnlyFallbackText(ctx.latestUserMessage);
    const genericShoppingFallback = /^tell me a bit more\b/i.test(fullResponseText.trim());
    const lacksPolicyTerms = policyFallback &&
      !/\b(return|returns|refund|exchange|30\s+days?|unworn|shipping|delivery|warranty|guarantee|support|customer service|order|tracking|discount|coupon|promo|code|sale|rewards?|loyalty|points?|vip)\b/i.test(fullResponseText);
    if (policyFallback && (genericShoppingFallback || lacksPolicyTerms)) {
      fullResponseText = policyFallback;
      pool = [];
      console.log(`[legacy-cov] path=finalize-policy-contract-wipe gate=!llmOwnsTurnActive`);
      console.log("[chat] policy-contract: replaced generic/missing policy reply with deterministic support answer");
    }
  }

  if (isCompoundPolicyProductQuestion(ctx.latestUserMessage) && fullResponseText) {
    const additions = [];
    const policyFallback = compoundPolicyFallbackText(ctx.latestUserMessage);
    if (policyFallback && !compoundPolicyClausePresent(fullResponseText, ctx.latestUserMessage)) {
      additions.push(policyFallback);
    }
    if (
      pool.length > 0 &&
      (!PRODUCT_SHOPPING_NOUN_RE.test(fullResponseText) || detectAiNoMatchPhrasing(fullResponseText))
    ) {
      additions.push(compoundProductFallbackText(ctx));
    }
    if (additions.length > 0) {
      const genericFallback = /^tell me a bit more\b/i.test(fullResponseText.trim());
      fullResponseText = genericFallback
        ? additions.join(" ")
        : `${additions.join(" ")} ${fullResponseText}`.trim();
      console.log(`[chat] compound-contract: added missing clause(s) count=${additions.length}`);
    }
  }

  // Strip stray HTML the model sometimes emits (literal <br>, <p>, etc.).
  // The widget renders markdown / plain text, not HTML, so tags otherwise
  // surface as raw characters. Whitelist real HTML tag names so the
  // <<Option>> choice-button syntax used by the widget is never matched.
  if (fullResponseText) {
    const HTML_TAG = /<\/?(?:br|p|div|span|b|i|u|strong|em|small|sup|sub|ul|ol|li|h[1-6]|hr|a|img|figure|figcaption|blockquote|code|pre|table|thead|tbody|tr|td|th)(?:\s[^>]*)?\/?>/gi;
    fullResponseText = fullResponseText
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(HTML_TAG, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // When the active group declares a containment relationship
     // (Orthotics goesInside Footwear, Cases goesInside Phones, etc.),
     // also allow chips from the container group's categories. The AI
     // legitimately offers container-category chips during the
     // "what does it go inside?" turn, and stripping them damages the
     // assistant text the next turn's intent analyzer reads.
    let extraChipAllow = [];
    if (ctx.activeCategoryGroup?.goesInsideOf && Array.isArray(ctx.merchantGroups)) {
      const containerName = String(ctx.activeCategoryGroup.goesInsideOf).toLowerCase();
      const container = ctx.merchantGroups.find((g) => String(g?.name || "").toLowerCase() === containerName);
      if (container && Array.isArray(container.categories)) {
        extraChipAllow = container.categories;
      }
    }
    // 2026-06-03 narrow-by-question-scope: when the assistant's
    // question is about shoes/footwear specifically, narrow the
    // chip allow-list to categories that live inside the merchant-
    // configured Footwear group only. Without this, gender-scoped
    // `catalogCategories` includes Accessories and Orthotics
    // (valid catalog categories — but not shoe types), and they
    // survive the broader filterForbiddenCategoryChips strip.
    // Purely data-driven: pulls the Footwear group's categories
    // from ctx.merchantGroups; no hardcoded shoe vocabulary.
    let scopedAllow = ctx.catalogCategories;
    if (Array.isArray(ctx.merchantGroups) && ctx.merchantGroups.length > 0) {
      const narrowed = narrowChipAllowListForGroup(
        fullResponseText, ctx.catalogCategories, ctx.merchantGroups, "Footwear",
      );
      if (narrowed !== ctx.catalogCategories) {
        scopedAllow = narrowed;
        console.log(
          `[chat] ${ctx.shop} narrowed chip allow-list to Footwear group ` +
            `(${ctx.catalogCategories?.length || 0}→${narrowed.length}) ` +
            `for shoe-type question`,
        );
      }
    }
    const filtered = filterForbiddenCategoryChips(fullResponseText, scopedAllow, ctx.fullCatalogCategories, extraChipAllow);
    if (filtered.stripped.length > 0) {
      console.log(`[chat] ${ctx.shop} stripped off-catalog chips:`, filtered.stripped, "allowed:", scopedAllow, extraChipAllow.length > 0 ? `extra(via goesInsideOf):${extraChipAllow.join(",")}` : "");
    }
    fullResponseText = filtered.text;

    // Customer-rejection guard. When the customer's latest message
    // explicitly rejected a category ("doesn't like shoes", "not
    // into orthotics", "no sandals", "without boots"), strip any
    // chip in that rejected category from the AI's reply. The AI
    // sometimes offers <<Slippers>> / <<Sandals>> after the customer
    // said "doesn't like shoes" — both ARE shoes, contradicting
    // the customer's stated constraint.
    {
      const rejectedTerms = detectRejectedCategories(ctx.latestUserMessage);
      if (rejectedTerms.size > 0) {
        const r = stripRejectedCategoryChips(fullResponseText, rejectedTerms);
        fullResponseText = r.text;
        if (r.stripped.length > 0) {
          console.log(
            `[chat] ${ctx.shop} stripped customer-rejected chips: [${r.stripped.join(", ")}] ` +
              `(rejected terms in latest message: [${[...rejectedTerms].join(", ")}])`,
          );
        }
      }
    }

    // Strip <<Unisex>> / <<Other>> / <<Either>> / <<Both>> gender chips —
    // those aren't customer-facing gender choices (Unisex is a product-side
    // compatibility tag, not a gender). Catches both the bare label and
    // common qualifier suffixes the LLM occasionally appends, like
    // <<Unisex (any)>> or <<Unisex - kids>>. Also cleans up the trailing
    // space left when the chip is removed mid-text.
    {
      const unisexChipRe = /\s*<<\s*(?:Unisex|Other|Either|Both)(?:\s*[-—–:/(][^<>]*)?\s*>>/gi;
      if (unisexChipRe.test(fullResponseText)) {
        fullResponseText = fullResponseText.replace(unisexChipRe, "").replace(/[ \t]{2,}/g, " ");
        console.log(`[chat] ${ctx.shop} stripped non-gender chips (Unisex/Other/Either/Both)`);
      }
    }

    // Chip-label dedupe. The LLM occasionally rephrases the same
    // question twice in one reply (e.g. recommender's needMoreInfo
    // instruction provides a list and the model paraphrases each
    // entry), emitting the same chip group twice in the same
    // message. Strip any later occurrence of a chip label that
    // already appeared earlier (case-insensitive). Keep the first.
    {
      const seen = new Set();
      const before = fullResponseText;
      const dedupedText = fullResponseText.replace(/<<\s*([^<>]+?)\s*>>/g, (match, label) => {
        const key = String(label).trim().toLowerCase();
        if (!key) return "";
        if (seen.has(key)) return "";
        seen.add(key);
        return match;
      });
      if (dedupedText !== before) {
        fullResponseText = dedupedText.replace(/[ \t]{2,}/g, " ").trim();
        console.log(`[chat] ${ctx.shop} deduped repeated chip labels`);
      }
    }

    // Strip gender chips that contradict the catalog given the user's
    // mentioned categories. e.g. user said "boots" + AI offered <<Men's>>
    // when only women's boots exist → strip the Men's chip. Keeps both
    // when the mentioned category supports both, or when no category was
    // mentioned. Pure data — categoryGenderMap is computed from the
    // catalog every request.
    // Drop non-functional "Kids"/"Boys"/"Girls" gender chips the model
    // sometimes improvises — the catalog gender model has no kids facet,
    // so the chip is a dead-end regardless of inventory. Runs first and
    // unconditionally (independent of categoryGenderMap / category
    // mention) so it fires on the bare top-level gender question too.
    {
      const kidsFiltered = stripUnsupportedGenderChips(fullResponseText);
      if (kidsFiltered.stripped.length > 0) {
        console.log(`[chat] ${ctx.shop} stripped unsupported-gender chips:`, kidsFiltered.stripped);
      }
      fullResponseText = kidsFiltered.text;
    }

    if (ctx.categoryGenderMap) {
      const genderFiltered = filterContradictingGenderChips(
        fullResponseText,
        ctx.conversationText,
        ctx.categoryGenderMap,
      );
      if (genderFiltered.stripped.length > 0) {
        console.log(`[chat] ${ctx.shop} stripped contradicting-gender chips:`, genderFiltered.stripped);
      }
      fullResponseText = genderFiltered.text;
    }

    // Answer workflows with gender already resolved + clarification disallowed
    // must NOT carry gender navigation chips at all. TurnPlan owns gender, so
    // <<Men's>>/<<Women's>> chips here are an invalid draft — strip them entirely
    // (the upstream prompt should prevent them; this is the safety net) and SKIP
    // the decoration step. Decorating them into <<Women's sneakers>> only to have
    // a later boundary strip them is exactly what spun the validator-retry loop.
    const planSuppressesGenderChips =
      ctx?.turnPlan?.clarificationAllowed === false &&
      isAnswerWorkflow(ctx?.turnPlan) &&
      (ctx?.turnPlan?.gender === "men" || ctx?.turnPlan?.gender === "women");
    if (planSuppressesGenderChips) {
      const before = fullResponseText;
      // Remove any chip whose label starts with a gender token (bare or compound:
      // <<Men's>>, <<Women's sneakers>>, <<Men's shoes>>).
      fullResponseText = fullResponseText
        .replace(/<<\s*(?:men|women)(?:['’]?s)?\b[^>]*>>/gi, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (before !== fullResponseText) {
        console.log(
          `[chat] ${ctx.shop} turn-plan(${ctx.turnPlan.workflow}): stripped gender nav chips ` +
            `(gender=${ctx.turnPlan.gender} resolved, clarify=false) — gender is TurnPlan-owned`,
        );
      }
    } else {
      // Context-carrying gender chips: when a category is already in
      // scope, rewrite bare <<Men's>>/<<Women's>> navigation chips into
      // the self-contained compound (<<Men's shoes>>) so a tapped chip
      // carries its own context on the next turn. Runs AFTER the
      // contradicting-gender strip (only surviving chips get decorated)
      // and BEFORE the catalog-scoped boundary (the compound gets
      // catalog-validated — umbrella terms let "shoes" prove out via
      // group triggers).
      const categoryNoun = genderChipCategoryNounFromContext(ctx);
      if (categoryNoun) {
        const decorated = decorateGenderNavigationChips(fullResponseText, { categoryNoun });
        if (decorated.decorated.length > 0) {
          console.log(
            `[chat] ${ctx.shop} decorated gender navigation chips with scope category:`,
            decorated.decorated,
          );
        }
        fullResponseText = decorated.text;
      }
    }

    // Final product-navigation grounding boundary. Broad gender/category
    // availability is not enough: every recognized gender/category/color
    // chip must have at least one live catalog tuple under the customer's
    // current conjunction and merchant-configured active group.
    if (ctx.catalogFacetIndex) {
      const scoped = filterCatalogScopedNavigationChips(fullResponseText, {
        // overlayDefinedConstraints, not a spread: the latest-message
        // extraction emits undefined keys for facets the customer
        // didn't restate, and a spread would wipe the carried scope.
        constraints: overlayDefinedConstraints(
          currentCatalogScopeFromContext(ctx),
          productFacetConstraintsFromText(ctx.latestUserMessage, ctx),
        ),
        facetIndex: ctx.catalogFacetIndex,
        allowedCategories: allowedCatalogCategoriesFromContext(ctx),
        catalogCategories: ctx.fullCatalogCategories || ctx.catalogCategories || [],
        // Merchant-group umbrella vocabulary (names + triggers): a
        // carried-over scope value like category="footwear" is a GROUP
        // name, not a tuple category, and must not strip every chip
        // (2026-06-12 trace: <<Men's>>/<<Women's>> wrongly stripped).
        umbrellaCategoryTerms: umbrellaCategoryTermsFromGroups(ctx.merchantGroups),
      });
      if (scoped.stripped.length > 0) {
        console.log(
          `[chat] ${ctx.shop} stripped catalog-impossible navigation chips: ` +
            scoped.stripped.map((label) => JSON.stringify(label)).join(", "),
        );
      }
      fullResponseText = scoped.text;
    }
  }

  // Strip any markdown directive blocks (`:::name ... :::`) the model may
  // emit. Some Anthropic responses generate `:::product-list ... :::` blocks
  // listing handles separated by '|' as a markup directive — but our widget
  // doesn't render directives, so the literal markup leaks into the chat
  // message. Product cards already render via the separate `type: products`
  // SSE event, so we just strip the directive blocks entirely.
  if (fullResponseText) {
    fullResponseText = fullResponseText
      .replace(/:::[a-zA-Z][\w-]*[\s\S]*?:::/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }


  const collection = extractCollectionCTA(fullResponseText);
  fullResponseText = collection.text;

  let genericCTA = null;
  if (!supportCTA && fullResponseText) {
    const generic = extractGenericCTA(fullResponseText);
    fullResponseText = generic.text;
    genericCTA = generic.cta;
  }

  // Tool-call syntax leak strip. The model occasionally emits raw
  // <function_calls>, "search_products {...}", or other control
  // tokens in its visible text alongside the proper structured
  // tool_use block — those should never reach the customer.
  if (fullResponseText && TOOL_SYNTAX_LEAK_RE.test(fullResponseText)) {
    const before = fullResponseText.length;
    const stripped = stripToolCallSyntax(fullResponseText);
    // Defensive: if the strip would leave the reply nearly empty,
    // the leaked syntax was the entire response. Better to ship the
    // sanitized fragment than nothing — keep whatever's left, but
    // log so we can spot the upstream model glitch.
    fullResponseText = stripped;
    if (fullResponseText.length !== before) {
      console.log(
        `[chat] ${ctx.shop} stripped tool-call syntax from outbound text ` +
          `(${before}→${fullResponseText.length} chars)`,
      );
    }
  }

  // Hallucinated affirmation guard. Mirrors AVAILABILITY_DENIAL_RE
  // but for false POSITIVES: the AI claims "we absolutely carry
  // men's slippers" when categoryGenderMap says slippers is women-
  // only. The Stage-2 in-tool genderCategoryMismatch fix only fires
  // when the AI calls searchProducts with explicit gender+category
  // filters — when the AI answers from training memory without
  // calling any tool, that gate is bypassed. Detect the pattern in
  // the emitted text and rewrite to honest framing.
  //
  // Pool guard: only fires on card-less turns. When a search returned
  // real cards this turn, the cards are ground truth over the
  // aggregate categoryGenderMap — a stale/coarse map must not replace
  // a card-bearing reply with a flat denial rendered ABOVE the very
  // cards that disprove it (audit 2026-06-12). Gender-mismatched
  // cards are already handled by the card-side gender filters.
  if (ctx.categoryGenderMap && pool.length === 0) {
    const fa = detectFalseGenderCategoryAffirmation(fullResponseText, ctx.categoryGenderMap);
    if (fa) {
      console.log(
        `[chat] ${ctx.shop} detected false ${fa.requestedGender} ${fa.category} affirmation — ` +
          `rewriting to honest framing (available=${fa.availableGenders.join(",")})`,
      );
      const otherGender = fa.availableGenders.includes("women") ? "women's" : (fa.availableGenders.includes("men") ? "men's" : null);
      const tail = otherGender
        ? ` We do carry ${otherGender} ${fa.category.toLowerCase()} — happy to show those if helpful.`
        : "";
      fullResponseText =
        `We don't carry ${fa.requestedGender} ${fa.category.toLowerCase()} in our catalog.${tail}`;
    }
  }

  // Stock-claim hallucination guard. The SIZE & STOCK GROUNDING
  // prompt rule tells the AI to call get_product_details before
  // claiming a specific size is in stock. When it skips that call
  // and asserts availability anyway ("currently available in size
  // 9", "in stock in size 11", "we have it in 9.5"), the claim is
  // hallucinated — the AI doesn't have real-time inventory in its
  // training data. Detect the pattern; if get_product_details
  // wasn't called this turn, strip the affirmation and substitute
  // an honest deferral. Legitimate post-tool stock claims pass
  // through because the tool name is in toolsCalledThisTurn.
  if (
    fullResponseText &&
    !toolsCalledThisTurn.has("get_product_details") &&
    detectStockClaim(fullResponseText)
  ) {
    console.log(
      `[chat] ${ctx.shop} stock-claim without get_product_details — stripping affirmation`,
    );
    fullResponseText = stripStockClaim(fullResponseText);
  }

  // Outbound role-marker scrub. Belt-and-suspenders alongside
  // sanitizeHistory's inbound strip: if the model literally generated
  // "Human:" / "Assistant:" tokens in its reply (rare but observed
  // when sanitizeHistory missed a leak in a long-running session),
  // remove them before emit. Customers should NEVER see those tokens.
  // Strip leaked tool-call text (e.g. "<template_name>search_products</template_name>"
  // or raw "search_products { query: ... }" the LLM occasionally emits when
  // it gets confused under tool-first prompt rules). Production normally uses
  // the proper tool_use mechanism, but rare confusion can leak the call as
  // text. Scrub before emit so the customer never sees raw tool syntax.
  if (fullResponseText) {
    const tlk = scrubToolCallLeaks(fullResponseText);
    if (tlk.changed) {
      fullResponseText = tlk.text;
      console.log(`[chat] ${ctx.shop} stripped tool-call text leakage from outbound text`);
    }
  }

  if (fullResponseText) {
    const r = scrubRoleMarkers(fullResponseText);
    if (r.changed) {
      fullResponseText = r.text;
      console.log(`[chat] ${ctx.shop} stripped role-marker tokens from outbound text`);
    } else if (r.candidate !== fullResponseText && r.candidate.length < 5) {
      console.log(
        `[chat] ${ctx.shop} role-marker strip would leave ${r.candidate.length} chars — ` +
          `keeping original for empty-pool repair to handle`,
      );
    }
  }

  // Final empty-text guard. After the full strip cascade (banned
  // narration, length cap, list trim, denial validation, dedup,
  // tool-call syntax, role-marker, stock-claim) the response can
  // still end up empty if every layer trimmed something. Rather
  // than ship 0 chars, substitute a coherent fallback that fits
  // the turn shape (cards present vs not).
  if (!fullResponseText || fullResponseText.trim().length < 3) {
    if (pool.length > 0) {
      fullResponseText = isAnswerWorkflow(ctx.turnPlan)
        ? buildAnswerWorkflowExhaustionText(ctx.turnPlan, pool)
        : "Take a look — these are the closest matches I've got.";
      console.log(`[chat] ${ctx.shop} empty-text repair (pool=${pool.length}): substituted ${isAnswerWorkflow(ctx.turnPlan) ? "honest answer-workflow line" : "generic pitch"}`);
    } else if (productSearchAttempted) {
      fullResponseText = "I couldn't find a match for that — happy to try a different angle if you can tell me more.";
      console.log(`[chat] ${ctx.shop} empty-text repair (search-attempted, no pool): substituted clarify-ask`);
    } else {
      fullResponseText = "Could you tell me a bit more about what you're looking for?";
      console.log(`[chat] ${ctx.shop} empty-text repair (no search): substituted clarify-ask`);
    }
  }

  // TurnPlan DISPLAY AUTHORITY. When the plan requires products to be shown
  // (show / show_availability / show_focused), the answer-shape card suppressors
  // below must NOT fire. An availability turn ("do those come in black?") is
  // yes/no-shaped, yet TurnPlan owns it as show_availability with the directive
  // "ALWAYS show the product card — never suppress it." Letting the yes/no
  // suppressor wipe the pool there is a legacy owner contradicting TurnPlan.
  const planRequiresDisplay = planForcesProductDisplay(ctx?.turnPlan);

  if (pool.length > 0 && fullResponseText && !planRequiresDisplay) {
    if (isYesNoQuestion(ctx.latestUserMessage) && isYesNoAnswer(fullResponseText, pool)) {
      console.log(
        `[chat] ${ctx.shop} yes/no-suppress: customer asked yes/no, AI answered yes/no — ` +
          `suppressing card pool of ${pool.length} (would have been noise under the text answer)`,
      );
      pool.length = 0;
    }
  }

  // Product-noun detector used by both capability-check and policy-
  // question suppress blocks below. Keep these synced.
  const PRODUCT_NOUN_IN_USER_RE = /\b(?:sandals?|sneakers?|heels?|wedges?|boots?|loafers?|oxfords?|clogs?|slippers?|mary[- ]?janes?|slip[- ]?ons?|footwear|shoes?|orthotics?|insoles?|inserts?|footbeds?)\b/i;

  if (pool.length > 0 && fullResponseText && ctx.latestUserMessage && !planRequiresDisplay) {
    const userMsg = String(ctx.latestUserMessage);
    if (
      isCapabilityCheckAboutPriorProducts(userMsg) &&
      !PRODUCT_NOUN_IN_USER_RE.test(userMsg)
    ) {
      console.log(
        `[chat] ${ctx.shop} capability-check suppress: customer asked about ` +
          `prior products ("${userMsg.slice(0, 60)}") without introducing a ` +
          `new category — dropping card pool of ${pool.length}`,
      );
      pool.length = 0;
    }
  }

  if (pool.length > 0 && fullResponseText && ctx.latestUserMessage && !planRequiresDisplay) {
    const userMsg = String(ctx.latestUserMessage);
    if (
      isPolicyOrServiceQuestion(userMsg) &&
      !isCompoundPolicyProductQuestion(userMsg) &&
      !PRODUCT_NOUN_IN_USER_RE.test(userMsg)
    ) {
      console.log(
        `[chat] ${ctx.shop} policy-question suppress: customer asked a support/policy ` +
          `question ("${userMsg.slice(0, 60)}") without naming a product type — ` +
          `dropping card pool of ${pool.length}`,
      );
      pool.length = 0;
    }
  }

  // REMOVED: code_owned_comparison postprocessor (2026-06-08).
  // It replaced the LLM's real comparison text with a 2-product
  // template — "X is Color, category, $price; Y is Color, category,
  // $price. Pick the first if that style feels closer, or the
  // second if you prefer its look." That template was strictly
  // worse than what the LLM writes. The engine now declines
  // compare-shape turns (engineWantsThisTurn → COMPARE_SHAPE_RE),
  // so the LLM is the only path that authors compare answers — and
  // it does so with multi-paragraph, actually-useful prose. Verifier
  // skip (next block) already protects tech-concept compares; product
  // compares with subjects in pool also benefit from leaving the LLM
  // text alone.

  if (pool.length > 0 && fullResponseText) {
    // Skip the claim verifier on ALL comparison turns. The verifier
    // checks "universal claims" — does THIS claim hold for every card in
    // the pool? On a compare turn the LLM is making PER-PRODUCT
    // distinctions ("Jillian has bunions tag, Danika has removable
    // insole") — those are the WHOLE POINT of the comparison, not
    // universal claims to verify against every card. Live traces:
    // - "BioRocker vs UltraSky" (concept compare) → 775→55 chars
    //   when verifier saw "walking" on sandal cards.
    // - "compare Jillian and Danika" (product compare) → 1153→121
    //   chars when verifier saw "bunions" universal on Janey card
    //   (which doesn't have the bunions tag) and "removable insole"
    //   feature claim on pool that didn't have any removable-insole
    //   facts. Both are per-product distinctions, not universals.
    const userMsg = String(ctx?.latestUserMessage || "");
    const isCompareTurn = /\b(?:compare|comparison|vs\.?|versus|difference\s+between|which\s+(?:is|one\s+is)\s+(?:better|worse|best))\b/i.test(userMsg);
    const isKnowledgeTurn = isKnowledgeQuestionLocal(userMsg);
    const skipVerifier = isCompareTurn || isKnowledgeTurn;
    if (skipVerifier) {
      const reason = isKnowledgeTurn
        ? "knowledge turn — LLM is naming technologies/materials in prose, " +
          "catalog attribute names don't match the customer-facing tech labels"
        : "compare turn — LLM is making per-product distinctions, not universal claims";
      console.log(
        `[chat] response-contract: skipping verifier on ${reason}`,
      );
    } else {
      const before = fullResponseText;
      const repaired = repairProductTurnAssembly({ text: fullResponseText, pool, ctx });
      fullResponseText = repaired.text;
      if (repaired.changed) {
        console.log(
          `[chat] response-contract: repaired product turn (${repaired.logs.join("+")}) ` +
            `(${before.length}→${fullResponseText.length} chars, pool=${pool.length})`,
        );
      }
    }
  }

  // REMOVED: main-path code_owned_listing postprocessor (2026-06-08).
  // Like code_owned_comparison above, this was replacing LLM text with
  // a templated listing line ("Here are six women's sandals..."). With
  // the warmed-up synthesizer prompt the LLM writes better copy than
  // the template, and the synthesizer is constrained to ground claims
  // in real card facts. The LAST-RESORT code_owned_listing at line
  // ~2860 stays as an empty-text safety net (poolSize>0 ∧ textLen===0
  // is the canonical broken-state to rescue).
  // For compound policy+product turns, ensureCompoundPolicyClause
  // already prepends the policy clause (search "ensureCompoundPolicyClause").

  if (fullResponseText) {
    const inlineChips = stripUnsafeInlineChips(fullResponseText, { hasProducts: pool.length > 0 });
    if (inlineChips.changed) {
      console.log(`[chat] stripped unsafe inline chip(s) before emit (${inlineChips.reason})`);
      fullResponseText = inlineChips.text;
    }
  }

  // Run the coherent-text guard whenever the text is empty OR a pool
  // exists, so that an empty-text-with-pool state (e.g. response-length
  // cap + verifyClaimsAgainstCards together stripped to 0 chars) is
  // always rescued by the code-owned listing fallback. We must NEVER
  // emit textLen=0 with poolSize>0.
  if (fullResponseText || pool.length > 0) {
    const fallback = pool.length > 0
      ? "Here are the matching styles I found."
      : (looksLikeClarifyingQuestion(fullResponseText)
        ? "Could you tell me a bit more about what you're looking for?"
        : "I can help with that.");
    const coherent = ensureCompleteCustomerText({ text: fullResponseText, fallback });
    if (coherent.changed) {
      const reason = (!fullResponseText && pool.length > 0)
        ? `${coherent.reason}_with_pool`
        : coherent.reason;
      console.log(`[chat] response-contract: repaired incomplete sentence (${reason})`);
      fullResponseText = coherent.text;
    }
  }

  // Last-resort guard — runs AFTER every response-contract repair
  // (repairProductTurnAssembly, verifyClaimsAgainstCards,
  // buildCodeOwnedProductListingText, stripUnsafeInlineChips,
  // ensureCompleteCustomerText) and is the LAST text mutation before
  // the SSE emit. If any of those guards regress or a future repair
  // is inserted upstream that drops text to zero, this catches it
  // so the customer never sees empty prose under a card pool.
  //
  // Production trace (2026-06-02 14:21:18 UTC): repairProductTurnAssembly
  // reduced 149 → 0 chars via verified_claims(unverified_universal:
  // arch support), and the emit shipped textLen=0 poolSize=6. This
  // guard is the final invariant: poolSize>0 ⟹ textLen>0.
  if (pool.length > 0 && !String(fullResponseText || "").trim()) {
    const listing = buildCodeOwnedProductListingText({
      text: "",
      cards: pool,
      ctx,
      recommenderInvoked: false,
    });
    fullResponseText = (listing.text && listing.text.trim())
      || "Here are the closest styles I found.";
    console.warn(
      `[chat] empty-text final guard recovered after response-contract pool=${pool.length} ` +
        `len=${fullResponseText.length} reason=${listing.reason || "static_fallback"}`,
    );
  }

  {
    const compound = ensureCompoundPolicyClause(fullResponseText, ctx);
    if (compound.changed) {
      fullResponseText = compound.text;
      console.log("[chat] compound-contract: final guard restored missing policy clause");
    }
  }

  return { text: fullResponseText, pool, genericCTA };
}
