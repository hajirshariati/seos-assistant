import Anthropic from "@anthropic-ai/sdk";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFilesWithContent, incrementRateLimitHits } from "../models/ShopConfig.server";
import { getAttributeMappings } from "../models/AttributeMapping.server";
import { getCatalogCategories, getAllCatalogCategories, getCategoryGenderAvailability, getCategoryAttributeCoverage } from "../models/Product.server";
import { getActiveCampaigns, formatCampaignsForCS } from "../models/Campaign.server";
import { buildSystemPrompt } from "../lib/chat-prompt.server";
import { planTurn, buildTurnPlanPromptBlock, buildPlanClarifierRepair, planForcesProductDisplay, planRequiresSearch as planRequiresSearchFlag, clarifierGateDecision, isAnswerWorkflow, plannedWorkflowCardOwnerViolation, plannedSearchSkippedViolation, cardsNotInEvidencePool, textPresentsProducts, workflowDisablesTools, resolvedFamilyGender, isStrippedFragmentText, isOrthoticProductCard, messageExplicitlyAsksForShoes } from "../lib/turn-plan.server";
import { recordTurnInvariantViolation, logTurnInvariant, answerNamesProductNotInEvidence } from "../lib/turn-invariant.server";
import { classifyAvailability, buildAvailabilityAnswer, AVAILABILITY_RESULT, resolveAvailabilityRequest, isAvailabilityFollowUp, familyOfTitle, collectFamilyColors, constraintIntent, parseAvailabilityConstraints, parseRequestedColors, priorAvailabilityMessage, priorAvailabilityConstraints, variantDataDiagnostics, styleKeyOfTitle, styleNameOfTitle, availabilityTextCardColorMismatch } from "../lib/availability-truth";
import { detectSupportHandoffNeed, buildSupportHandoffText, supportConfigured, normalizedSupportLabel, supportChatLabel, applyAnswerSourceContract } from "../lib/support-handoff";
import { extractConstraintPlan, cardMatchesSlotCategory, multiRecoTextCardMismatch, slotSearchCategory } from "../lib/constraint-plan";
import { detectProcessNarration, stripProcessNarration, buildSalesVoiceFallback, SALES_JUDGMENT_WORKFLOWS } from "../lib/sales-voice";
import { classifyTurnScope, scopeAttributesToTurn, isShortAmbiguousReply, messageStatesShoeEnvironment } from "../lib/turn-scope";
import { buildPriorEvidenceAvailabilityText, buildPriorEvidenceMultiColorText, askedConstraintLabel, titleCaseWord, buildWidthSizeFallbackText } from "../lib/prior-evidence";
import { selectEvidenceCards } from "../lib/evidence-select";
import { retrieveRelevantChunks } from "../lib/knowledge-chunks.server";
import { buildKidsCoveragePrompt } from "../lib/kids-coverage.server";
import { analyzeCategoryIntent, cardMatchesActiveGroup, textIntentDivergesFromGroup, matchingGroupsForText } from "../lib/category-intent.server";
import { extractAnsweredChoices } from "../lib/conversation-memory.server";
import {
  detectGenderFromHistory as _detectGenderFromHistory,
  reconcileSessionGender,
  looksLikeProductPitch,
  hasChoiceButtons,
  isSingularPrescriptive,
  hasPluralIntroFraming,
  detectConditionOrOccasion,
  containsAvailabilityDenial,
  stripLineupPromiseSentences,
  isCapabilityCheckAboutPriorProducts,
  isBrandOrInfoQuestion,
} from "../lib/chat-helpers.server";
import { TOOLS, executeTool, extractProductCards, CUSTOMER_ORDERS_TOOL, FIT_PREDICTOR_TOOL, detectLatestGender } from "../lib/chat-tools.server";
import { rewriteToolCall } from "../lib/chat-tool-rewrite.server";
import {
  deriveCatalogRequirements,
  matchCatalogRequirement,
} from "../lib/catalog-query.server.js";
import { withAnthropicRetry, classifyAnthropicError, customerFacingFailureMessage } from "../lib/anthropic-resilience.server";
// Phase 1 of the architecture migration: LLM_OWNS_ALL_TURNS flag
// (defaults ON; LLM_OWNS_ALL_TURNS=false is the kill switch). When
// active, the dispatcher cascade and ~50 post-processors are skipped —
// one model call (with retry on grounding failures) owns the turn.
// Imported DYNAMICALLY inside the action (same pattern as
// product-turn-engine.server) because Vite flags static server-module
// imports referenced by route files as client-leakage.
import { fetchCustomerContext } from "../lib/customer-context.server";
import { fetchKlaviyoEnrichment } from "../lib/klaviyo-enrichment.server";
import { fetchYotpoLoyalty } from "../lib/yotpo-loyalty.server";
import { buildRecommenderTools } from "../lib/recommender-tools.server";
import { maybeRunOrthoticFlow, isOrthoticHostileReply, isOrthoticConfusionReply, priorTurnWasOrthoticSeedQuestion, orthoticPendingFlowDecision } from "../lib/orthotic-flow-gate.server";
import { classifyOrthoticTurn, shouldRunOrthoticClassifier } from "../lib/orthotic-classifier.server";
import { resolveCatalogTurn, buildResolverStatePromptBlock, extractUserConstraints, detectSpecificProduct, mentionsCatalogProductFamily, extractCatalogProductFamilies } from "../lib/catalog-resolver.server";
import { getCatalogFacetIndex, normalizeGender } from "../lib/catalog-facts.server";
import { catalogScopedNavigationQuestionVerdict, umbrellaCategoryTermsFromGroups } from "../lib/catalog-matcher.server";
import { buildSessionMemory, detectClarifyingQuestionType, memorySummary, buildSessionMemoryPromptBlock } from "../lib/session-memory.server";
import {
  SKU_PATTERN,
  createTurnResult,
  rewriteDenialWithProducts,
  dropSiblingCards,
  buildCodeOwnedProductListingText,
  buildCodeOwnedExactNoMatchText,
  buildSoftBrowseFallbackText,
  ensureProductTurnCards,
  extractCollectionCTA,
  extractOrphanSkus,
  extractSupportCTA,
  currentCatalogScopeFromContext,
  prepareProductCardsForTurn,
  resolveProductTurnLink,
  scoreCardAgainstText,
  skusFromCardText,
  stripMissingSkus,
  isDirectProductFactQuestion,
  titleStyleFamily,
  detectNamedProductMismatch,
  ensureCompleteCustomerText,
  validateTurnResult,
} from "../lib/response-contract.server";
import {
  detectSingularIntent,
  detectAiPivotPhrasing,
  detectUserSignupIntent,
  detectAiSignupMention,
  detectBroadNeed,
  detectAiNoMatchPhrasing,
  looksLikeClarifyingQuestion,
  suggestionContradictsGender,
  isUnanswerableSuggestion,
  haikuEscalationSignal,
  sonnetEscalationSignal,
  detectFootwearOverElicitation,
  resolverPromisedRecommendation,
  dropNonFootwearWhenFootwearIntent,
  dropRejectedCategoryCards,
  stripDisallowedClarifierQuestions,
  dropNonShoppableItems,
  detectComparisonIntent,
  resolveFocusedCardByName,
  parseCategoryConstraints,
  negationCorruptedPositiveCategory,
} from "../lib/chat-postprocessing";
import {
  finalizeOutboundReply,
  isKnowledgeQuestionLocal,
  llmOwnsTurnActive,
  allowedCatalogCategoriesFromContext,
  productFacetConstraintsFromText,
  isPolicyOrServiceQuestion,
  isCompoundPolicyProductQuestion,
  scopedProductSearchInput,
  buildAnswerWorkflowForcedSearch,
  alignCardsToAnswerText,
  familyFromQuery,
  isPivotResetTurn,
  pivotSearchScopeLeak,
  isBroadGenderReset,
  broadGenderFollowUpGender,
  workflowSuppressesCards,
  specQuestionAnsweredAsAvailability,
  answerSourceMatrix,
  isKnowledgeWorkflow,
  isPrivateHandoffWorkflow,
  ownerAuthorizedForWorkflow,
  isWorkflowAgnosticOwner,
} from "../lib/emit-finalize.server";
import { detectConversationGoal, ANCHOR_GOALS, isBroadGenderRequest, broadGenderRequestGender } from "../lib/turn-intent.server";
import { isOrthoticSandalCompatibilityQuestion, buildOrthoticCompatibilityAnswer, hasExplicitOrthoticCompatibleEvidence, isUnsafeCompatibilitySuggestion, SAFE_COMPATIBILITY_SUGGESTIONS } from "../lib/compatibility-truth.server";
import { buildVisualizeCtaEvent } from "../lib/visualize-cta.server";
import prisma from "../db.server";
import { recordChatUsage, getTodayMessageCount } from "../models/ChatUsage.server";
import { computeEmbeddingCost } from "../lib/pricing.server";
import { canSendMessage } from "../lib/billing.server";
import { normalizeVariantSize, normalizeVariantWidth } from "../lib/variant-matcher.server";

// Model IDs are env-driven so you can update them in Railway without a code
// deploy. When Anthropic ships a new model:
//   1. Railway → Service → Variables → set OPUS_MODEL=<new-id> (or HAIKU/DEFAULT)
//   2. Service auto-restarts
//   3. Smoke-test a few chats; if anything's off, revert the env var
// Defaults below are the current best as of code commit time. Without env vars
// set, behavior is unchanged.
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-sonnet-4-6";
const HAIKU_MODEL = process.env.HAIKU_MODEL || "claude-haiku-4-5-20251001";
const OPUS_MODEL = process.env.OPUS_MODEL || "claude-opus-4-7";
const MAX_TOKENS = parseInt(process.env.CHAT_MAX_TOKENS, 10) || 1024;
const MAX_TOOL_HOPS = parseInt(process.env.CHAT_MAX_TOOL_HOPS, 10) || 3;

// Suitability / advisory-shape questions — "will this hold up for all-day
// walking?", "is it more of a casual sandal?", "good enough for...", "can I
// wear these to...". These are NOT product-list turns: the customer wants a
// JUDGMENT, so the per-card "write one brief listing sentence" directive is
// wrong for them. When this matches the latest user message we ask the model
// for a real recommendation with honest tradeoffs instead. False positives
// are low-harm (a slightly richer answer), so the pattern errs inclusive.
const ADVISORY_INTENT_RE = new RegExp(
  "\\bhold(?:s)?\\s+up\\b" + "|" +
  "\\b(?:durable|sturdy|long[-\\s]?lasting|hard[-\\s]?wearing)\\b" + "|" +
  "\\bmore\\s+of\\s+a\\b" + "|" +
  "\\bcasual\\s+(?:stroll|wear|or\\b)" + "|" +
  "\\b(?:good|ok|okay|suitable|right|ideal|appropriate|enough|comfortable|fine|work(?:s)?)\\s+(?:enough\\s+)?(?:for|to)\\b" + "|" +
  "\\b(?:all[-\\s]?day|week[-\\s]?long|every[-\\s]?day|hours?\\s+of)\\b" + "|" +
  "\\bcan\\s+i\\s+(?:wear|use)\\b" + "|" +
  "\\bwould\\s+(?:this|it|these|they)\\s+(?:work|hold|be)\\b" + "|" +
  "\\bis\\s+(?:this|it|that|the)\\b[^.?!\\n]{0,40}\\b(?:casual|dressy|formal|active|sporty|athletic|supportive)\\b",
  "i",
);

const DEPRECATED_MODELS = new Set(["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20240620", "claude-opus-4-20250514"]);

const RATE_LIMIT_PER_IP_SHOP = parseInt(process.env.RATE_LIMIT_PER_IP_SHOP, 10) || 20;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000;
const RATE_LIMIT_MAX_KEYS = parseInt(process.env.RATE_LIMIT_MAX_KEYS, 10) || 10_000;

const ipShopBuckets = new Map();

function clientIp(request) {
  const xff = request.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0].trim();
  return first || request.headers.get("x-real-ip") || "unknown";
}

function checkIpShopRate(shop, ip) {
  const key = `${shop}|${ip}`;
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const bucket = (ipShopBuckets.get(key) || []).filter((t) => t > cutoff);
  if (bucket.length >= RATE_LIMIT_PER_IP_SHOP) {
    const retryAfter = Math.max(1, Math.ceil((bucket[0] + RATE_LIMIT_WINDOW_MS - now) / 1000));
    ipShopBuckets.set(key, bucket);
    return { ok: false, retryAfter };
  }
  bucket.push(now);
  ipShopBuckets.set(key, bucket);
  if (ipShopBuckets.size > RATE_LIMIT_MAX_KEYS) {
    const evictCount = ipShopBuckets.size - RATE_LIMIT_MAX_KEYS;
    let evicted = 0;
    for (const k of ipShopBuckets.keys()) {
      if (evicted >= evictCount) break;
      if (k === key) continue;
      ipShopBuckets.delete(k);
      evicted++;
    }
  }
  return { ok: true };
}

if (!globalThis.__shopagentRateSweeper) {
  globalThis.__shopagentRateSweeper = setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    for (const [key, bucket] of ipShopBuckets) {
      const filtered = bucket.filter((t) => t > cutoff);
      if (filtered.length === 0) ipShopBuckets.delete(key);
      else ipShopBuckets.set(key, filtered);
    }
  }, RATE_LIMIT_WINDOW_MS);
  globalThis.__shopagentRateSweeper.unref?.();
}

// Defensive cleanup of inbound chat history. The widget client may
// re-send a previous turn whose `content` accidentally captured a
// raw "Human:" / "Assistant:" role marker (from an upstream model
// glitch or a copy-paste from a transcript export). Without this,
// the marker rides into the next request as ordinary message text
// and the next-turn model sometimes echoes it back to the customer
// ("Human: Assistant, wait for the tool results..."). Strip leading
// role tokens defensively. Idempotent — no-op on clean history.
function sanitizeHistory(history) {
  const out = [];
  for (const turn of history || []) {
    if (!turn?.role || !turn?.content) continue;
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    let content = String(turn.content).replace(/^\s*(?:Human|Assistant)\s*:\s*/i, "");
    content = content.replace(/\n\s*(?:Human|Assistant)\s*:\s*/gi, "\n");
    // Surface the product cards that were DISPLAYED under this
    // assistant turn. The widget sends them back as turn.products but
    // the model previously only saw the reply text — which is usually
    // one sentence that names nothing. Live trace 2026-06-10: "What
    // sizes does the first one come in?" was unanswerable because
    // "the first one" pointed at a card the model couldn't see; it
    // asked a from-scratch clarifying question instead. The bracketed
    // note gives the model ordinal/reference resolution; facts still
    // come from fresh tool calls per the grounding rules.
    if (turn.role === "assistant" && llmOwnsTurnActive() && Array.isArray(turn.products) && turn.products.length > 0) {
      const shown = turn.products
        .slice(0, 10)
        .map((p, i) => {
          const title = String(p?.title || "").trim();
          if (!title) return null;
          const price = String(p?.price_formatted || p?.price || "").trim();
          return `${i + 1}. ${title}${price ? ` (${price})` : ""}`;
        })
        .filter(Boolean);
      if (shown.length > 0) {
        content += `\n\n[Product cards displayed with this reply: ${shown.join("; ")}]`;
      }
    }
    out.push({ role: turn.role, content });
  }
  return out;
}

function compactHistoryProducts(products) {
  if (!Array.isArray(products)) return [];
  return products
    .filter(Boolean)
    .slice(0, 10)
    .map((p) => ({
      handle: String(p.handle || "").trim(),
      title: String(p.title || "").trim(),
      url: String(p.url || "").trim(),
      image: String(p.image || p.image_url || "").trim(),
      price_formatted: String(p.price_formatted || p.price || "").trim(),
      price: p.price,
      compare_at_price: p.compare_at_price,
      category: p.category || p._category || p.productType || "",
      _category: p._category || p.category || p.productType || "",
      gender: p.gender || p._gender || "",
      _gender: p._gender || p.gender || "",
      _variantFacts: p._variantFacts || p.variantFacts || {},
    }))
    .filter((p) => p.handle || p.title);
}

function extractPriorProductCards(history) {
  for (let i = (history || []).length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn?.role !== "assistant") continue;
    const products = compactHistoryProducts(turn.products);
    if (products.length > 0) return products;
  }
  return [];
}

// Capitalized 4+ char tokens the LLM mentioned in prior assistant text
// that aren't already represented in the rendered product cards. When
// the LLM says "our bestseller is Danika" but doesn't attach Danika as
// a card, Danika still becomes the conversation's CURRENT anchor — the
// next turn's pronoun ("does it run small?" / "is that in stock?")
// should resolve to Danika, not to the most-recently-displayed pool.
//
// Returns a Set of lowercased anchor tokens from the MOST RECENT
// assistant turn (one turn back). Caller can pass these to the resolver
// to seed memory.inferred.specificProduct so the next turn isn't blind
// to what the LLM just talked about.
const NAMED_ANCHOR_STOPWORDS = new Set([
  "women", "womens", "men", "mens", "kids", "girls", "boys", "child", "youth", "unisex",
  "sandal", "sandals", "sneaker", "sneakers", "heel", "heels", "wedge", "wedges",
  "boot", "boots", "loafer", "loafers", "oxford", "oxfords", "clog", "clogs",
  "slipper", "slippers", "footwear", "shoe", "shoes", "slip", "orthotic", "orthotics",
  "the", "this", "that", "those", "these", "here", "there", "they",
  "perfect", "great", "best", "good", "really", "very", "available", "view", "all",
  "color", "colors", "style", "styles", "size", "sizes", "fit", "feel", "feels",
  "morton", "plantar", "fasciitis", "bunion", "bunions",
  "yotpo", "aetrex", "klaviyo", "shopify",
  "biorocker", "ultrasky", "lynco",
]);

// Resolve an ORDINAL / positional reference to one of the previously shown
// cards: "the second one", "second pair", "I like the first", "the last one".
// Returns the card or null. Pure + order-preserving (cards are in display
// order). Used so selection / cart turns can pin the exact product.
const ORDINAL_INDEX = {
  first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2,
  fourth: 3, "4th": 3, fifth: 4, "5th": 4, sixth: 5, "6th": 5,
};
function resolveOrdinalCard(message, cards) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  const m = String(message || "").toLowerCase();
  if (/\blast\s+(?:one|pair|option|product|style)?\b/.test(m)) return cards[cards.length - 1] || null;
  for (const [word, idx] of Object.entries(ORDINAL_INDEX)) {
    // The ordinal must be a selection reference: followed by one/pair/option/…
    // or preceded by "the" ("the second", "second pair"). Avoids matching a
    // stray "first" in unrelated prose.
    const re = new RegExp(`\\b(?:the\\s+)?${word}\\b(?:\\s+(?:one|pair|option|product|style|shoe|sandal|sneaker|boot|pick))?`, "i");
    if (re.test(m) && (new RegExp(`\\bthe\\s+${word}\\b`, "i").test(m) || new RegExp(`\\b${word}\\b\\s+(?:one|pair|option|product|style|shoe|sandal|sneaker|boot|pick)`, "i").test(m))) {
      return cards[idx] || null;
    }
  }
  return null;
}

function extractLLMNamedAnchors(history) {
  const lastAssistant = [...(history || [])].reverse().find((t) => t?.role === "assistant");
  if (!lastAssistant?.content) return [];
  const text = typeof lastAssistant.content === "string"
    ? lastAssistant.content
    : Array.isArray(lastAssistant.content)
      ? lastAssistant.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join(" ")
      : "";
  if (!text) return [];
  const anchors = new Set();
  const re = /\b([A-Z][a-z]{3,})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lower = m[1].toLowerCase();
    if (!NAMED_ANCHOR_STOPWORDS.has(lower)) anchors.add(lower);
  }
  return [...anchors];
}

// All cards shown across the entire conversation (cumulative, not just
// the most recent turn). Used by the soft-browse rotation so a 3rd
// "show me something else" doesn't recycle browse #1's cards. Returns
// a flat array of compact card objects; de-duplication happens at the
// consumer side (priorlyShownHandles uses a Set).
function extractAllPriorProductCards(history) {
  const out = [];
  for (const turn of history || []) {
    if (turn?.role !== "assistant") continue;
    const products = compactHistoryProducts(turn.products);
    if (products.length > 0) out.push(...products);
  }
  return out;
}

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}


const SIMPLE_PATTERN = /^(hi|hey|hello|thanks|thank you|ok|okay|yes|no|bye|goodbye|cool|great|got it|perfect|sure|nice|awesome|alright|yep|nope|sounds good|that helps|appreciate it)\s*[.!?]*$/i;
const LOW_RISK_SHOPPING_RE = /\b(?:show|find|browse|shop|looking for|look for|need|want|have|carry|any|in|under|below|less than|cheaper|cheap|sale|deals?|how about|what about)\b/i;
const PRODUCT_LISTING_TERM_RE = /\b(?:shoes?|footwear|sneakers?|sandals?|boots?|loafers?|clogs?|wedges?|heels?|slippers?|oxfords?|mary janes?|slip[-\s]?ons?|slides?|flats?|styles?|pairs?|men'?s|women'?s|kids?|boys?|girls?|black|white|brown|navy|blue|pink|red|grey|gray|tan|taupe|silver|gold|cream|ivory|beige|purple|green|orange|yellow|\$\s*\d+)\b/i;
const HIGH_RISK_ROUTING_RE = /\b(?:orthotic|insole|insert|plantar|fasciitis|diabetic|neuropathy|bunion|metatarsalgia|morton's|heel pain|foot pain|arch pain|overpronation|flat feet|high arch|compare|comparison|vs\.?|versus|difference|better|best for|recommend|what should|why|how does|return|refund|exchange|shipping|delivery|warranty|discount code|promo code|loyalty|rewards?|order|tracking|support|contact|waterproof|material|review|run small|run large|size up|size down|wide|narrow|available in size|in stock)\b/i;

function isLowRiskShoppingTurn(message) {
  const value = String(message || "").trim();
  if (!value || value.length > 140) return false;
  if (HIGH_RISK_ROUTING_RE.test(value)) return false;
  return LOW_RISK_SHOPPING_RE.test(value) && PRODUCT_LISTING_TERM_RE.test(value);
}

function productAuthorityModeEnabled() {
  return String(process.env.PRODUCT_TURN_ENGINE_ENABLED || "").toLowerCase() === "true";
}

const detectGenderFromHistory = _detectGenderFromHistory;

function chooseModel(config, message, history) {
  const strategy = config.modelStrategy || "smart";
  const stored = config.anthropicModel || DEFAULT_MODEL;
  const sonnet = DEPRECATED_MODELS.has(stored) ? DEFAULT_MODEL : stored;

  if (strategy === "always-haiku") return HAIKU_MODEL;
  if (strategy === "always-opus") return OPUS_MODEL;
  if (strategy === "cost-optimized" && isLowRiskShoppingTurn(message)) {
    return HAIKU_MODEL;
  }
  if (strategy !== "smart" && strategy !== "cost-optimized") return sonnet;

  if (history.length > 0 && message.length < 80 && SIMPLE_PATTERN.test(message.trim())) {
    return HAIKU_MODEL;
  }
  return sonnet;
}

function addUsage(acc, usage) {
  acc.input_tokens += usage.input_tokens || 0;
  acc.output_tokens += usage.output_tokens || 0;
  acc.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
  acc.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
}

// ============================================================
// TOOL-CALL REWRITE PIPELINE — SUPPORT
// ----------------------------------------------------------------
// Pure rewrite functions live in app/lib/chat-tool-rewrite.server.js
// so the eval harness can import + test them outside the React
// Router bundler. loadMerchantColors stays here because it reads
// Prisma — it's the one place merchant color enumeration touches
// the DB. It populates ctx._merchantColors which the rewrite
// pipeline consumes.
// ============================================================

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;
function escapeRe(s) {
  return String(s).replace(RE_ESCAPE, "\\$&");
}

// The exact displayed product name for a pinned card (used by the deterministic
// EvidencePlan fallback). Never invents — just the card's own title.
function cardDisplayName(card) {
  return String(card?.title || "").trim();
}

// Deterministic concise fallback for a multi_recommendation turn, built ONLY
// from the pinned evidence cards + their slot categories. Shipped when the LLM's
// phrasing can't pass the grounding validator (too_long) so the pinned cards
// survive instead of being dropped to a support handoff. Shape:
// "Here are three strong starting points: the X for sandals, the Y for
// sneakers, and the Z for slippers."
function buildMultiRecoFallbackText(pairs) {
  const items = (pairs || [])
    .filter((p) => p && p.card && cardDisplayName(p.card))
    .map((p) => {
      const name = cardDisplayName(p.card);
      const cat = String(p.category || "").trim();
      return cat ? `the ${name} for ${cat}` : `the ${name}`;
    });
  if (items.length === 0) return null;
  const NUM = ["", "one", "two", "three", "four", "five", "six"];
  let list;
  if (items.length === 1) list = items[0];
  else if (items.length === 2) list = `${items[0]} and ${items[1]}`;
  else list = `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
  const lead =
    items.length === 1
      ? "Here's a strong starting point:"
      : `Here are ${NUM[items.length] || items.length} strong starting points:`;
  return `${lead} ${list}.`;
}

async function loadMerchantColors(ctx) {
  if (Array.isArray(ctx._merchantColors)) return ctx._merchantColors;
  try {
    const products = await prisma.product.findMany({
      where: { shop: ctx.shop, NOT: { status: { in: ["DRAFT", "ARCHIVED"] } } },
      select: { attributesJson: true, variants: { select: { attributesJson: true } } },
      take: 1500,
    });
    const colorKeys = ["color", "Color", "color_family", "Color Family", "color_fallback"];
    const colorSet = new Set();
    const addFrom = (attrs) => {
      if (!attrs || typeof attrs !== "object") return;
      for (const k of colorKeys) {
        const v = attrs[k];
        if (!v) continue;
        const arr = Array.isArray(v) ? v : [v];
        for (const x of arr) {
          const s = String(x || "").trim().toLowerCase();
          if (s && s.length >= 3 && s.length <= 30) colorSet.add(s);
        }
      }
    };
    for (const p of products) {
      addFrom(p.attributesJson);
      for (const variant of (p.variants || [])) addFrom(variant.attributesJson);
    }
    ctx._merchantColors = Array.from(colorSet);
    console.log(`[chat] color-enum: ${ctx._merchantColors.length} distinct color values from catalog`);
  } catch (err) {
    console.error("[chat] color enumeration failed:", err?.message || err);
    ctx._merchantColors = [];
  }
  return ctx._merchantColors;
}

// ============================================================
// dispatchTool — guarantee EVERY tool dispatch goes through the
// rewrite pipeline.
// ----------------------------------------------------------------
// The main agentic loop already runs rewriteToolCall before each
// executeTool call. But there are FOUR recovery paths in this file
// (SKU-recovery, condition/occasion-recovery, denial-recovery,
// auto-broaden) that historically called executeTool directly,
// bypassing rewriteToolCall — meaning gender-lock, color injection,
// scope-reset, and comparison-routing all silently no-op'd for them.
//
// dispatchTool is the one-entry-point fix. Every recovery path now
// goes through it. Future recovery paths added later will inherit
// rewrite-pipeline coverage automatically.
// ============================================================
async function dispatchTool(name, input, ctx) {
  let rewritten = rewriteToolCall({ name, input }, ctx);
  if (
    rewritten.name === "search_products"
    && !Array.isArray(rewritten.input?.requiredTerms)
  ) {
    const catalogScope = {
      ...(ctx?.sessionMemory?.explicit || {}),
      ...(ctx?.classifiedIntent?.attributes || {}),
      ...(ctx?.resolverState?.matched_constraints || {}),
    };
    const requirements = deriveCatalogRequirements({
      latestUserMessage: ctx?.latestUserMessage || "",
      messages: ctx?.messages || [],
      scope: catalogScope,
      claimConfig: ctx?.claimConfig || null,
      knownCategories: ctx?.fullCatalogCategories || ctx?.catalogCategories || [],
    });
    if (requirements.requiredTerms.length > 0) {
      rewritten = {
        ...rewritten,
        input: {
          ...(rewritten.input || {}),
          requiredTerms: requirements.requiredTerms,
        },
      };
      console.log(
        `[chat] catalog requirements: terms="${requirements.requiredTerms.join(" | ")}"` +
          `${requirements.continuedFromPrior ? " source=immediate-prior-turn" : " source=latest-message"}`,
      );
    }
  }
  return await executeTool(rewritten.name, rewritten.input, ctx);
}

function resolverRequiresCatalogProof(ctx = {}) {
  return (
    ctx.resolverState?.recommended_next_action?.type === "no_match" ||
    (Array.isArray(ctx.resolverState?.impossible_constraints) &&
      ctx.resolverState.impossible_constraints.length > 0)
  );
}

function catalogGroundedSuggestionVerdict(question, ctx = {}) {
  const choice = productFacetConstraintsFromText(question, ctx);
  const current = {
    ...currentCatalogScopeFromContext(ctx),
    ...productFacetConstraintsFromText(ctx.latestUserMessage, ctx),
  };
  return catalogScopedNavigationQuestionVerdict({
    question,
    choice,
    constraints: current,
    impossibleConstraints: ctx.resolverState?.impossible_constraints || [],
    facetIndex: ctx.catalogFacetIndex,
    allowedCategories: allowedCatalogCategoriesFromContext(ctx),
    requireProof: resolverRequiresCatalogProof(ctx),
    // Umbrella group words ("footwear", "shoes") parsed as a facet
    // category must not prove impossibility — derived purely from the
    // merchant's category-group config. 2026-06-12 trace.
    umbrellaCategoryTerms: umbrellaCategoryTermsFromGroups(ctx.merchantGroups),
  });
}

function filterCatalogGroundedSuggestions(questions, ctx = {}) {
  const input = Array.isArray(questions) ? questions : [];
  const kept = [];
  const dropped = [];
  for (const question of input) {
    const verdict = catalogGroundedSuggestionVerdict(question, ctx);
    if (verdict.possible) kept.push(question);
    else dropped.push(verdict);
  }
  if (dropped.length > 0) {
    console.log(
      `[chat] ${ctx.shop} catalog-grounding dropped ${dropped.length}/${input.length} suggestion(s): ` +
        dropped
          .map((verdict) =>
            `${JSON.stringify(String(verdict.question).slice(0, 70))} ` +
            `(${verdict.reason}; scope=${JSON.stringify(verdict.effectiveConstraints)})`,
          )
          .join(", "),
    );
  }
  return kept;
}

// Phase 1 dispatcher for the Product Turn Engine. Returns:
//   { handled: true, ... }   — engine emitted text/products/done; caller returns.
//   { declined: true, ... }  — engine declined (named-product, compare, no
//                              category). Caller falls through to the
//                              existing agent path unchanged.
//   null                     — engine flag is OFF or could not run; caller
//                              proceeds with the existing path.
//
// searchFn translates the engine's scope into a single
// search_products call via the existing dispatchTool — we do NOT
// build a second search system. Color-family expansion is honored:
// when scope.colorFamily is present we widen the search by passing
// the family color list into the existing filters.color shape that
// search_products already supports (single canonical color), and
// the engine's selection layer then prefers exact-color matches.
async function runProductTurnDispatch({ ctx, controller, encoder, claimConfig, anthropic }) {
  const enabled = String(process.env.PRODUCT_TURN_ENGINE_ENABLED || "").toLowerCase() === "true";
  if (!enabled) return null;

  // Dynamic import keeps RR's client bundler from following the
  // prisma-touching module chain into the client build.
  const { runProductTurn } = await import("../lib/product-turn-engine.server");

  const searchFn = async (scope) => {
    const limit = ctx?.productCardCap || 6;
    // Named-product anchor: customer's latest message contains a
    // specific catalog product ("what's the spec on Reagan?", "tell
    // me about the Maui", "show me Jillian"). Look it up DIRECTLY
    // and use it as the lead candidate. Without this, the resolver's
    // 6 generic candidates (category-only) shadow the customer's
    // explicit choice — live trace 2026-06-08: "what's the spec on
    // the Reagan boot?" returned Luna, Victoria, Addie boots (the
    // resolver's top 6 women's boots), not Reagan.
    const latestMsg = String(ctx.latestUserMessage || "");
    if (latestMsg && /\b[A-Z][a-z]{3,}\b/.test(latestMsg)) {
      try {
        // Strict resolver first (token must be unique to one product).
        // Live trace 2026-06-08: "Reagan" appears in BOTH reagan-black-ah600w
        // AND reagan-red-ah609w → strict resolver returns null (token isn't
        // unique). Fall back to findProductHandleForSimilarAnchor which
        // accepts any handle from a style family.
        let namedHandle = await detectSpecificProduct(ctx.shop, latestMsg);
        if (!namedHandle) {
          const { findProductHandleForSimilarAnchor } =
            await import("../lib/catalog-resolver.server");
          namedHandle = await findProductHandleForSimilarAnchor(ctx.shop, latestMsg);
        }
        if (namedHandle) {
          const details = await dispatchTool("get_product_details", { handle: namedHandle }, ctx);
          const namedCards = extractProductCards("get_product_details", details, ctx);
          if (namedCards.length > 0) {
            console.log(
              `[product-turn-engine] searchFn lead candidate: named product "${namedHandle}" detected in message`,
            );
            // Lead with the named product, then top up with resolver
            // candidates / category alternatives so the customer can
            // browse if Reagan isn't quite right. Cap at `limit`.
            const out = [...namedCards];
            if (out.length < limit && resolverPromisedRecommendation(ctx.resolverState)) {
              const altHandles = (ctx.resolverState.candidate_products || [])
                .map((p) => p?.handle)
                .filter(Boolean)
                .filter((h) => h !== namedHandle)
                .slice(0, limit - out.length);
              for (const h of altHandles) {
                try {
                  const altDetails = await dispatchTool("get_product_details", { handle: h }, ctx);
                  out.push(...extractProductCards("get_product_details", altDetails, ctx));
                } catch {/* skip */}
                if (out.length >= limit) break;
              }
            }
            return out.slice(0, limit);
          }
        }
      } catch (err) {
        console.warn(`[product-turn-engine] named-product lead lookup failed: ${err?.message || err}`);
      }
    }
    if (resolverPromisedRecommendation(ctx.resolverState)) {
      const handles = (ctx.resolverState.candidate_products || [])
        .map((p) => p?.handle)
        .filter(Boolean)
        .slice(0, limit);
      const candidateCards = [];
      for (const handle of handles) {
        try {
          const details = await dispatchTool("get_product_details", { handle }, ctx);
          candidateCards.push(...extractProductCards("get_product_details", details, ctx));
        } catch (err) {
          console.warn(`[product-turn-engine] resolver candidate ${handle} lookup failed: ${err?.message || err}`);
        }
      }
      if (candidateCards.length > 0) {
        console.log(
          `[product-turn-engine] searchFn using ${candidateCards.length} resolver candidate card(s) before semantic search`,
        );
        return candidateCards;
      }
    }
    const filters = {};
    if (scope.gender) filters.gender = scope.gender;
    if (scope.category) filters.category = scope.category;
    if (scope.color) filters.color = scope.color;
    if (scope.badge) filters.badge = scope.badge;
    const queryParts = Array.from(new Set([
      scope.catalogQuery,
      scope.modifier,
      scope.badge,
      scope.condition,
      scope.color,
      scope.category,
      scope.useCase,
    ].filter(Boolean)));
    const query = queryParts.length > 0
      ? queryParts.join(" ").trim()
      : (scope.rawMessage || "").slice(0, 160);
    const baseInput = {
      query,
      filters,
      limit,
      requiredTerms: scope.requiredCatalogTerms || [],
    };
    if (scope.onSale === true) baseInput.onSale = true;
    const runSearch = async (input) => {
      try {
        const r = await dispatchTool("search_products", input, ctx);
        if (!r || r.error || !Array.isArray(r.products)) return [];
        return extractProductCards("search_products", r, ctx);
      } catch (err) {
        console.warn(`[product-turn-engine] searchFn failed: ${err?.message || err}`);
        return [];
      }
    };
    // extractProductCards is idempotent w.r.t. _claimFacts.
    let cards = await runSearch(baseInput);
    // Empty-pool retry. When the customer asked an availability
    // question ("Do you have orthotics for kids?") and the dispatcher
    // appended an auto-filled useCase (e.g. "comfort_walking_everyday")
    // to the query, the synthetic tokens can starve the semantic
    // search and return zero — even when the gender+category bucket
    // has matching products in the catalog. Retry once with just the
    // category as the query string, keeping the structured filters.
    if (cards.length === 0 && scope.category) {
      const retryQuery = scope.category;
      if (retryQuery !== query) {
        console.log(
          `[product-turn-engine] searchFn retry: query="${query}" returned 0; ` +
            `re-running with query="${retryQuery}" + same filters`,
        );
        cards = await runSearch({ ...baseInput, query: retryQuery });
      }
    }
    return cards;
  };

  // similarFn — Phase 2. REUSE the existing find_similar_products
  // handler so the engine inherits the merchant's admin-configured
  // similarMatchAttributes + category/gender filters + same-style-
  // family exclusion. No parallel similarity engine.
  const similarFn = async ({ handle, limit }) => {
    try {
      const result = await dispatchTool("find_similar_products", { handle, limit }, ctx);
      if (!result || result.error || !Array.isArray(result.products)) return result;
      return {
        ...result,
        products: extractProductCards("find_similar_products", result, ctx),
      };
    } catch (err) {
      console.warn(`[product-turn-engine] similarFn failed: ${err?.message || err}`);
      return { error: err?.message || "similar lookup failed", products: [] };
    }
  };

  // resolveNamedProductFn — REUSE catalog-resolver named-product
  // detectors. Two-stage resolution so we don't re-implement
  // anchor matching:
  //   1) detectSpecificProduct — strict (unique-token requirement)
  //      for whole-name mentions like "the Jillian Sport Sandal".
  //   2) findProductHandleForSimilarAnchor — permissive, returns
  //      ANY matching handle from a style family. Live 2026-06-03
  //      fix: "Which has most cushioning like the Jillian?" and
  //      "same support as Danika" returned null from the strict
  //      resolver because Aetrex carries multiple Jillian/Danika
  //      products and the token wasn't unique. find_similar_products
  //      excludes the entire style family anyway, so any handle is
  //      a valid anchor.
  const { detectSpecificProduct, findProductHandleForSimilarAnchor } =
    await import("../lib/catalog-resolver.server");
  const resolveNamedProductFn = async (message) => {
    try {
      const strict = await detectSpecificProduct(ctx.shop, message);
      if (strict) return strict;
      const fuzzy = await findProductHandleForSimilarAnchor(ctx.shop, message);
      if (fuzzy) return fuzzy;
      // LLM-named-anchor fallback. When the customer's latest message
      // uses a pronoun ("is it in stock?", "does that come in black?")
      // and the resolver can't find an anchor in the message itself,
      // fall back to whatever product the LLM most recently named in
      // text. ctx.llmNamedAnchors is extracted from the prior assistant
      // turn's prose by extractLLMNamedAnchors. This is how "Danika is
      // our bestseller — does it run small?" stays anchored to Danika
      // across turns even though Danika never made it into a card pool.
      const anchors = Array.isArray(ctx.llmNamedAnchors) ? ctx.llmNamedAnchors : [];
      const pronounRefRe = /\b(?:it|this|that|these|those|them|they)\b/i;
      if (anchors.length > 0 && pronounRefRe.test(message)) {
        for (const name of anchors) {
          const hit = await detectSpecificProduct(ctx.shop, name)
            || await findProductHandleForSimilarAnchor(ctx.shop, name);
          if (hit) {
            console.log(`[product-turn-engine] anchor resolver: LLM-named fallback → "${name}" matched`);
            return hit;
          }
        }
      }
      return null;
    } catch (err) {
      console.warn(`[product-turn-engine] anchor resolver failed: ${err?.message || err}`);
      return null;
    }
  };

  // Yotpo / AfterShip enrichment. Engine asks for review + return
  // data only on review-shaped turns ("highest review", "best
  // rated", "return rate"). Parallel fetches per handle; failures
  // per handle don't take down the whole turn (engine still
  // composes from whatever did succeed).
  const fetchReviewsFn = (ctx?.yotpoApiKey || ctx?.aftershipApiKey)
    ? async (handles) => {
        const { executeTool } = await import("../lib/chat-tools.server");
        const results = await Promise.all(
          handles.map(async (h) => {
            const [rev, ret] = await Promise.all([
              ctx.yotpoApiKey
                ? executeTool("get_product_reviews", { handle: h }, ctx).catch(() => null)
                : Promise.resolve(null),
              ctx.aftershipApiKey
                ? executeTool("get_return_insights", { handle: h }, ctx).catch(() => null)
                : Promise.resolve(null),
            ]);
            const merged = {};
            if (rev && !rev.error) {
              merged.averageScore = rev.averageScore;
              merged.totalReviews = rev.totalReviews;
              merged.fitSummary = rev.fitSummary;
              if (rev.topPositiveReview?.text) {
                merged.topPositiveReview = rev.topPositiveReview;
              }
            }
            if (ret && !ret.error) {
              // AfterShip data is INTERNAL — only the sizingAdvice
              // string ("Returns skew toward 'too small' — recommend
              // sizing up.") is allowed to reach the LLM-voice
              // synthesizer. Raw totals, return reasons, and counts
              // never leave the engine. Customers must not see "X%
              // of orders are returned" or "common reason: too tight."
              if (ret.sizingAdvice) {
                merged.returnSizingAdvice = ret.sizingAdvice;
              }
            }
            return [h, merged];
          }),
        );
        return Object.fromEntries(results.filter(([, v]) => v && Object.keys(v).length > 0));
      }
    : null;

  // Voice synthesizer. Engine still owns selection, lead pick, CTA,
  // chips — this only rewrites the deterministic template into
  // warmer prose using ONLY the facts the engine grounded. Strict
  // rules in the prompt forbid inventing details and forbid
  // describing UI. Falls back silently if Haiku errors / empties.
  const synthesizeFn = anthropic
    ? async ({ latestUserMessage, scope, leadCard, deterministicText, selectionReason, familyCount, deferredCount, willHaveCta }) => {
        const leadTitle = String(leadCard?.title || "").trim();
        if (!leadTitle) return null;
        const facts = {
          customer_asked: String(latestUserMessage || "").slice(0, 240),
          recommended_product: leadTitle,
          recommended_color: leadCard?._color || leadCard?.color || "",
          recommended_price: leadCard?.price_formatted || leadCard?.priceRange || "",
          scope_gender: scope?.gender || "",
          scope_category: scope?.category || "",
          scope_color: scope?.color || "",
          scope_modifier: scope?.modifier || "",
          requested_claim: scope?.requestedClaim?.kind || "",
          requested_condition: scope?.requestedClaim?.tag || "",
          required_feature: (scope?.requiredCatalogTerms || [])[0] || "",
          other_options_count: Math.max(0, (familyCount || 0) - 1),
          deferred_count: deferredCount || 0,
          selection_reason: selectionReason || "",
          has_view_all_button: !!willHaveCta,
          template_for_reference: deterministicText,
          // Yotpo data — present only on review-shaped turns. May be
          // quoted verbatim (rating, count, fit summary, positive
          // review snippet). Empty/null fields must be ignored.
          lead_review_average: leadCard?._reviewAvg ?? null,
          lead_review_count: leadCard?._reviewCount ?? null,
          lead_review_fit_summary: leadCard?._reviewFit || "",
          lead_top_positive_review: leadCard?._topPositiveReview || null,
          // AfterShip data — INTERNAL ONLY. May be paraphrased into
          // a sizing nudge ("tends to run small — many people size
          // up"). MUST NOT be quoted as return rate / reason / count.
          lead_return_sizing_advice_internal: leadCard?._returnSizingAdvice || "",
        };
        const prompt =
          `You're texting a friend who's shopping for shoes. Quick, helpful, warm — like a real associate, not a product description writer.\n\n` +
          `FACTS YOU MAY USE (do NOT invent anything outside this list):\n${JSON.stringify(facts, null, 2)}\n\n` +
          `Write 1–2 short sentences. Lead with the recommended product by name and one specific reason it fits. Keep it conversational.\n\n` +
          `VOICE — what to AVOID (these are the templated phrases you keep falling into):\n` +
          `- "I'd recommend our [Product] — it's a great choice for [scope]" ← banned. Sounds like a brochure.\n` +
          `- "is a solid choice at $X" ← banned. No "solid choice".\n` +
          `- "is the perfect pick / best match / great option" ← banned. No superlatives without a reason.\n` +
          `- "We have N other styles available too if you'd like to explore different colors or fits" ← banned filler. If alternatives matter, mention them naturally.\n` +
          `- Starting with "Great question!", "Perfect!", "Absolutely!", "Of course!" ← banned. Skip the warm-up; get to the answer.\n` +
          `- Listing back the customer's question ("Looking for women's sandals? Here are some great options!") ← banned.\n\n` +
          `VOICE — examples of warmer phrasing the assistant SHOULD sound like:\n` +
          `- "The Whit Sport Sandal is a strong pick for long-day walking — the contoured footbed takes the pressure off your arch."\n` +
          `- "If you want something dressy that's still walkable, the Andrea works — it's leather but lined for comfort."\n` +
          `- "Danika has 4.7 stars across 142 reviews. Dana said the cushion holds up after weeks of daily wear."\n` +
          `- "Jillian runs a little narrow up front — a lot of customers size up half a size."\n` +
          `- "Honestly, your best bet is the Reagan — it's built for boots-but-flat days."\n` +
          `Notice the pattern: name the product, give ONE concrete reason rooted in the facts, no superlative without proof.\n\n` +
          `RULES FOR WEAVING IN OPTIONAL FACTS:\n` +
          `- If lead_review_count > 0: you MAY weave in the rating + count naturally ("4.7 stars across 142 reviews"). Skip if 0/null.\n` +
          `- If lead_top_positive_review is present AND the customer asked about reviews/fit/quality: include ONE short quote attributed by first name (e.g. \`Diana said, "fits true to size and so comfortable."\`). Skip if null.\n` +
          `- If lead_return_sizing_advice_internal is present: you MAY paraphrase it as a sizing nudge ONLY ("tends to run small, so a lot of customers size up"). NEVER quote return rates or mention returns existing.\n` +
          `- If other_options_count > 0, drop ONE phrase like "a few more options in the cards too" — don't list them.\n` +
          `- If has_view_all_button is true AND other_options_count === 0, you may say "open the card to see colors" once.\n\n` +
          `MATERIAL / FEATURE HONESTY:\n` +
          `- If customer_asked names a specific material/tech (cork, leather, waterproof, memory foam, vegan, merino, BioRocker, etc.) AND required_feature is empty AND the facts don't include that term:\n` +
          `  - DO NOT pretend the recommended product has it.\n` +
          `  - Open by saying we don't carry that specifically, then offer the closest alternative from the facts. Example: "We don't carry anything with cork insoles, but the Maui has a contoured EVA footbed that feels similar."\n` +
          `  - Stay confident; no "unfortunately" or apology.\n` +
          `- If customer_asked uses RELATIONAL phrasing referring to prior conversation ("both technologies", "all of these", "either of those features", "with that tech", "the same combo"):\n` +
          `  - DO NOT claim the recommended product has "both" / "all" / "either" of anything. You don't know what the customer is referring to — that lives in the prior turn, not in your facts.\n` +
          `  - Pivot to a generic, honest answer: name the product, give ONE concrete reason from the facts you DO have, and invite them to browse. Example: "The Maui is a popular pick for everyday wear — I'm not certain which specific tech combo you're asking about, but you can check the spec on each card."\n` +
          `  - Never echo "both technologies" / "all the features" / "same combo" as if it were verified.\n\n` +
          `STRICT RULES:\n` +
          `- Never invent names, colors, prices, materials, tech, sizes, or claims not in the facts.\n` +
          `- Never describe UI ("click", "tap", "button below") except the one allowed "open the card" line.\n` +
          `- Vary phrasing across turns. Do NOT mirror the template_for_reference.\n` +
          `- NEVER mention return rates, return percentages, return reasons, or that you have return data.\n` +
          `- No greetings ("Hi!", "Sure!"), no sign-offs, no emojis, no bullets, no markdown.\n` +
          `- Plain prose. 1–2 sentences. Max ~35 words total.\n\n` +
          `Customer-facing reply:`;
        try {
          // COST AUDIT (docs/cost-accounting-audit.md): this product-turn voice
          // synthesis is an auxiliary Haiku call that is NOT separately metered
          // into ChatUsage. Small + fires on a subset of turns; covered by the
          // estimator's documented SIDE_CALL_OVERHEAD allowance.
          const r = await anthropic.messages.create({
            model: HAIKU_MODEL,
            max_tokens: 160,
            messages: [{ role: "user", content: prompt }],
          });
          return r?.content?.[0]?.text?.trim() || "";
        } catch (err) {
          console.warn(`[product-turn-engine] voice synth haiku failed: ${err?.message || err}`);
          return null;
        }
      }
    : null;

  let out;
  try {
    out = await runProductTurn(ctx, {
      searchFn,
      similarFn,
      resolveNamedProductFn,
      claimConfig,
      synthesizeFn,
      fetchReviewsFn,
    });
  } catch (err) {
    console.error(`[product-turn-engine] runProductTurn threw: ${err?.stack || err?.message || err}`);
    return null;
  }
  if (!out) return null;
  if (out.decline) return { declined: true, diagnostics: out.diagnostics };

  // Emit text → products → link? → done. Engine output is
  // true-by-construction — bypass postprocessors that could zero
  // it out.
  //
  // CTA conversion: engine returns scope only (gender + category +
  // optional color). Dispatcher resolves to a renderable storefront
  // URL via buildStorefrontSearchCTA — reuses the merchant's
  // admin-configured storefrontSearchUrlPattern + ctaOverrides so
  // we don't build a parallel URL system. Widget contract is
  // `{ type:"link", url, label }` (verified against
  // hajirai-chat-widget.js — only `type:"link"` renders as a CTA
  // button).
  const text = String(out.answerText || "").trim();
  const products = Array.isArray(out.products) ? out.products : [];
  controller.enqueue(encoder.encode(sseChunk({ type: "text", text })));
  controller.enqueue(encoder.encode(sseChunk({ type: "products", products })));
  if (Array.isArray(out.choices) && out.choices.length > 0) {
    controller.enqueue(encoder.encode(sseChunk({
      type: "choices",
      options: out.choices,
    })));
  }
  const linkPayload = await convertEngineCtaToLink(out.cta, ctx);
  if (linkPayload) {
    controller.enqueue(encoder.encode(sseChunk({
      type: "link",
      url: linkPayload.url,
      label: linkPayload.label,
    })));
  }
  const groundedFollowUps = filterCatalogGroundedSuggestions(out.followUps, ctx);
  if (groundedFollowUps.length > 0) {
    controller.enqueue(encoder.encode(sseChunk({
      type: "suggestions",
      questions: groundedFollowUps,
    })));
  }
  controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
  return {
    handled: true,
    answerText: text,
    products,
    diagnostics: {
      ...out.diagnostics,
      cta: linkPayload ? linkPayload.label : null,
      followUps: groundedFollowUps.length,
    },
  };
}

function isColorFactFollowUp(text = "") {
  const value = String(text || "");
  if (/\b(?:size|sizes|width|wide|narrow|stock|in\s+stock|available\s+in\s+size)\b/i.test(value)) return false;
  return (
    /\b(?:colors?|colou?rs?|colorways?)\b/i.test(value) ||
    /\b(?:other|more|different|available)\s+(?:colors?|colou?rs?|colorways?)\b/i.test(value) ||
    /\bcome(?:s)?\s+in\s+(?:other|more|different)?\s*(?:colors?|colou?rs?|colorways?)\b/i.test(value)
  );
}

function requestedSizeWidthScope(text = "") {
  const value = String(text || "");
  const out = { size: null, width: null };
  const sizeMatch =
    value.match(/\bsize\s+(\d{1,2}(?:\.\d|½| 1\/2)?)\b/i) ||
    value.match(/\b(\d{1,2}(?:\.\d|½| 1\/2)?)\s*(?:wide|narrow|medium|regular|standard|w\b|n\b|m\b)/i);
  if (sizeMatch) out.size = normalizeVariantSize(sizeMatch[1]);
  const widthMatch = value.match(/\b(extra[-\s]?wide|xw|wide|narrow|slim|medium|regular|standard|[wnm])\b/i);
  if (widthMatch) out.width = normalizeVariantWidth(widthMatch[1]);
  return out;
}

function isSizeWidthFactFollowUp(text = "") {
  const value = String(text || "");
  if (!/\b(?:size|sizes|width|widths|wide|narrow|medium|regular|standard|in\s+stock|available)\b/i.test(value)) {
    return false;
  }
  const scope = requestedSizeWidthScope(value);
  return Boolean(scope.size || scope.width);
}

function variantColorsFromCards(cards = []) {
  const seen = new Set();
  const out = [];
  const add = (value) => {
    const display = String(value || "").trim();
    if (!display || /^miscellaneous$/i.test(display)) return;
    const key = display.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(display);
  };
  for (const card of Array.isArray(cards) ? cards : []) {
    const facts = card?._variantFacts || card?.variantFacts || {};
    for (const color of facts.availableColors || []) add(color);
    for (const color of facts.styleAvailableColors || []) add(color);
    const attrColor = card?._attributes?.Color || card?._attributes?.color || card?.color;
    if (attrColor) add(attrColor);
  }
  return out;
}

function displayList(values = [], max = 8) {
  const list = values.filter(Boolean).slice(0, max);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}

function variantFactsFromCard(card) {
  return card?._variantFacts || card?.variantFacts || {};
}

function normalizedFactValues(values = [], normalizer) {
  const raw = Array.isArray(values) ? values : [values];
  const out = [];
  const seen = new Set();
  for (const value of raw.flat(Infinity)) {
    const normalized = normalizer(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function cardVariantSizeWidthSummary(card) {
  const facts = variantFactsFromCard(card);
  return {
    sizes: normalizedFactValues([facts.availableSizes, facts.sizes], normalizeVariantSize),
    widths: normalizedFactValues([facts.availableWidths, facts.widths], normalizeVariantWidth),
  };
}

function buildSizeWidthFactAnswer({ cards, scope }) {
  const size = normalizeVariantSize(scope?.size);
  const width = normalizeVariantWidth(scope?.width);
  if (!size && !width) return null;

  const compactCards = (Array.isArray(cards) ? cards : []).filter(Boolean).slice(0, 6);
  if (compactCards.length === 0) return null;

  if (size && width) {
    return {
      text:
        `I can't confirm the exact size ${size} ${width} combination from these cards without checking a specific style. ` +
        `Open the card you like to confirm live size and width availability, or tell me which style you want me to check.`,
      products: compactCards,
      reason: "size_width_combo_not_stamped",
    };
  }

  const matches = compactCards.filter((card) => {
    const summary = cardVariantSizeWidthSummary(card);
    if (size) return summary.sizes.includes(size);
    if (width) return summary.widths.includes(width);
    return false;
  });

  const label = size ? `size ${size}` : `${width} width`;
  if (matches.length > 0) {
    const names = displayList(matches.map((card) => card.title).filter(Boolean), 3);
    return {
      text:
        `From the current cards, ${names || "some styles"} list ${label}. ` +
        `Open a card to confirm live inventory before choosing.`,
      products: compactCards,
      reason: "variant_fact_listed",
    };
  }

  return {
    text:
      `I don't see ${label} listed in the current cards' variant facts. ` +
      `Try another size or width, or open a style to confirm live availability.`,
    products: compactCards,
    reason: "variant_fact_not_listed",
  };
}

async function runVariantFactDispatch({ ctx, controller, encoder }) {
  const enabled = String(process.env.PRODUCT_TURN_ENGINE_ENABLED || "").toLowerCase() === "true";
  if (!enabled) return null;
  const latest = String(ctx?.latestUserMessage || "");
  const isColorFact = isDirectProductFactQuestion(latest) && isColorFactFollowUp(latest);
  const sizeWidthScope = requestedSizeWidthScope(latest);
  const isSizeWidthFact = isDirectProductFactQuestion(latest) && isSizeWidthFactFollowUp(latest);
  if (!isColorFact && !isSizeWidthFact) return null;

  let cards = Array.isArray(ctx?.priorProductCards) ? ctx.priorProductCards : [];
  let usedSearch = false;
  if (isSizeWidthFact) {
    const answer = buildSizeWidthFactAnswer({ cards, scope: sizeWidthScope });
    if (!answer) return null;
    controller.enqueue(encoder.encode(sseChunk({ type: "text", text: answer.text })));
    controller.enqueue(encoder.encode(sseChunk({ type: "products", products: answer.products.slice(0, ctx?.productCardCap || 6) })));
    controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
    return {
      handled: true,
      answerText: answer.text,
      products: answer.products,
      diagnostics: {
        usedSearch: false,
        variantFactKind: "size_width",
        reason: answer.reason,
      },
    };
  }

  if (variantColorsFromCards(cards).length === 0) {
    const scoped = scopedProductSearchInput(ctx);
    const hasScope = Boolean(scoped.scope.gender || scoped.scope.category || scoped.scope.color);
    if (!hasScope) return null;
    const searchInput = {
      ...scoped.input,
      limit: Math.max(ctx?.productCardCap || 6, 6),
    };
    try {
      const result = await dispatchTool("search_products", searchInput, ctx);
      cards = extractProductCards("search_products", result, ctx);
      usedSearch = true;
    } catch (err) {
      console.warn(`[variant-facts] search failed: ${err?.message || err}`);
      return null;
    }
  }

  const colors = variantColorsFromCards(cards);
  if (colors.length === 0) return null;

  const currentColor = String(currentCatalogScopeFromContext(ctx).color || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const otherColors = currentColor
    ? colors.filter((c) => c.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() !== currentColor)
    : colors;
  const scope = currentCatalogScopeFromContext(ctx);
  const base = [
    scope.gender === "men" ? "men's" : scope.gender === "women" ? "women's" : scope.gender === "kids" ? "kids'" : "",
    scope.category ? String(scope.category).replace(/-/g, " ") : "styles",
  ].filter(Boolean).join(" ");
  const shown = displayList(otherColors.length > 0 ? otherColors : colors);
  const text = otherColors.length > 0
    ? `Yes — the ${base || "styles"} I found also come in ${shown}. Open a card to choose the exact style and color.`
    : `I'm only seeing ${shown} in the current ${base || "style"} results. Open a card to confirm live size and color availability.`;

  controller.enqueue(encoder.encode(sseChunk({ type: "text", text })));
  controller.enqueue(encoder.encode(sseChunk({ type: "products", products: cards.slice(0, ctx?.productCardCap || 6) })));
  controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
  return {
    handled: true,
    answerText: text,
    products: cards,
    diagnostics: { usedSearch, colors: colors.length, otherColors: otherColors.length },
  };
}

// Convert the engine's structured CTA object into a widget-
// renderable {url, label} pair. Returns null when no CTA is
// emittable. Reuses merchant-admin pattern + overrides via
// buildStorefrontSearchCTA — no parallel URL builder.
async function convertEngineCtaToLink(cta, ctx) {
  if (!cta) return null;
  if (cta.kind === "external_link" && cta.url) {
    return { url: cta.url, label: cta.label || "Open" };
  }
  if (cta.kind === "storefront_search") {
    const { buildStorefrontSearchCTA } = await import("../lib/storefront-search-cta.server");
    const built = buildStorefrontSearchCTA({
      pattern: ctx.storefrontSearchUrlPattern || "",
      overrides: ctx.ctaOverrides || [],
      gender: cta.gender || ctx.sessionGender || "",
      category: cta.category || "",
      color: cta.color || "",
      modifier: cta.modifier || "",
      latestUserMessage: ctx.latestUserMessage || "",
    });
    if (built && built.url) {
      // Surface the actual emitted URL so a wrong-destination
      // (e.g. modifier=sale but URL goes to bestseller) is
      // diagnosable against the merchant's storefrontSearchUrlPattern
      // + ctaOverrides without guessing.
      console.log(
        `[chat] ${ctx.shop} engine cta url=${built.url} label=${JSON.stringify(built.label || "View all")} ` +
          `from scope={gender:${cta.gender || "-"},category:${cta.category || "-"},color:${cta.color || "-"},modifier:${cta.modifier || "-"}} ` +
          `overrides=${(ctx.ctaOverrides || []).length}`,
      );
      return { url: built.url, label: built.label || "View all" };
    }
    return null;
  }
  return null;
}

function resolverHasExactNoMatch(resolverState) {
  if (!resolverState || resolverState.type !== "resolver_state") return false;
  // Only a HARD catalog facet (color/gender/category) genuinely absent
  // warrants a "we don't carry that" denial that also blocks search. A
  // no_match on a SOFT orthotic attribute (useCase/condition/arch/...)
  // must NOT deny the whole gender+category nor skip the search (prod
  // trace 2026-06-24: "insoles or shoes for foot pain at work" → no
  // work_all_day orthotic SKU → bot falsely said "I couldn't find men's
  // footwear" and never searched). Let those fall through to a normal
  // search so real men's footwear + orthotics surface.
  const impossible = Array.isArray(resolverState.impossible_constraints)
    ? resolverState.impossible_constraints
    : [];
  return impossible.some(
    (c) => c?.field === "color" || c?.field === "gender" || c?.field === "category",
  );
}

// Catalog truth boundary. When the resolver has already proved the
// requested scope is impossible, do not let the product engine or
// legacy LLM/tool fallback "helpfully" broaden it into false cards.
// This owns cases like "pink men's footwear": answer honestly, clear
// products, and stop.
async function runResolverNoMatchDispatch({ ctx, controller, encoder }) {
  if (!resolverHasExactNoMatch(ctx?.resolverState)) return null;
  if (isCompoundPolicyProductQuestion(ctx?.latestUserMessage)) return null;
  const exactNoMatch = buildCodeOwnedExactNoMatchText({ ctx });
  const text = String(exactNoMatch?.text || "").trim();
  if (!text) return null;

  // Sales-associate behaviour: when the no-match is because the
  // customer pivoted to a gender that doesn't carry the requested
  // category (e.g. "how about mens?" after women's loafers), offer
  // the categories that DO exist for that gender in the active
  // merchant group as chips. Bot says "no men's loafers — but in
  // men's we have..." and the chips let them keep shopping.
  //
  // Owned by the same engine that emits browse-clarifier chips, so
  // chip generation, umbrella filtering, and gender grounding all
  // flow through one helper. No second source of authority.
  const impossible = Array.isArray(ctx.resolverState?.impossible_constraints)
    ? ctx.resolverState.impossible_constraints
    : [];
  const genderMiss = impossible.find((c) => c?.field === "gender" && c?.value);
  let alternativeChoices = [];
  if (genderMiss) {
    const { buildAlternativeCategoryChoices } = await import("../lib/product-turn-engine.server");
    alternativeChoices = buildAlternativeCategoryChoices(ctx, genderMiss.value);
  }

  controller.enqueue(encoder.encode(sseChunk({ type: "text", text })));
  controller.enqueue(encoder.encode(sseChunk({ type: "products", products: [] })));
  if (alternativeChoices.length >= 2) {
    controller.enqueue(encoder.encode(sseChunk({
      type: "choices",
      options: alternativeChoices,
    })));
  }
  controller.enqueue(encoder.encode(sseChunk({ type: "done" })));

  return {
    handled: true,
    answerText: text,
    diagnostics: {
      reason: exactNoMatch.reason || "exact_catalog_no_match",
      impossible,
      alternativeChoices: alternativeChoices.length,
    },
  };
}

// Phase 3 — Policy / Knowledge dispatcher. Same flag, same
// short-circuit semantics as the product engine. Always emits
// products=[] so the widget clears any stale product cards from a
// previous turn. Engine reuses the retrievedChunks the request
// already resolved upstream — no second RAG query.
async function runPolicyTurnDispatch({ ctx, controller, encoder, retrievedChunks, anthropic }) {
  const enabled = String(process.env.PRODUCT_TURN_ENGINE_ENABLED || "").toLowerCase() === "true";
  if (!enabled) return null;

  // Dynamic import keeps RR's client bundler from following the
  // prisma chain into the client build.
  const { runPolicyTurn } = await import("../lib/policy-engine.server");

  // Haiku-backed answer synthesizer. Reads the merchant policy
  // chunks and the customer's specific question, returns a SHORT
  // targeted answer. Replaces the verbatim Q&A block-dump customers
  // complained about 2026-06-03. Falls back to the verbatim stitch
  // inside the engine if this throws / times out / returns empty.
  const synthesizeFn = anthropic
    ? async ({ latestUserMessage, intent, relevantChunks, haveContactButton }) => {
        const chunksBody = relevantChunks
          .slice(0, 4)
          .map((c) => {
            const title = c.sectionTitle ? `[${c.sectionTitle}]\n` : "";
            return `${title}${String(c.content || "").trim()}`;
          })
          .filter(Boolean)
          .join("\n\n---\n\n")
          .slice(0, 2400);
        const contactLine = haveContactButton
          ? "\n- If a detail isn't covered in the policy, say so briefly and tell the customer to use the contact button below — DO NOT invent details."
          : "\n- If a detail isn't covered in the policy, say so briefly. DO NOT invent details.";
        const prompt =
          `You are answering a customer's question about ${intent?.primary || "store policy"} for a Shopify store.\n\n` +
          `CUSTOMER QUESTION:\n"${String(latestUserMessage).slice(0, 500)}"\n\n` +
          `STORE POLICY (authoritative — only use facts from here):\n${chunksBody}\n\n` +
          `Write a short, direct answer to the customer's SPECIFIC question(s).\n` +
          `RULES:\n` +
          `- 1-3 sentences. Friendly but concise. No greetings, no sign-offs.\n` +
          `- Answer ONLY what they asked. Don't dump the whole policy.\n` +
          `- If they asked compound questions (e.g. warranty AND exchange AND shipping), answer each in ONE clause.\n` +
          `- Use plain prose, NOT bullet lists, NOT Q/A format.\n` +
          `- Never invent numbers, time windows, fees, or URLs that aren't in the policy text above.${contactLine}\n` +
          `- Don't say "Tap the button below" or describe UI — the button renders separately.\n\n` +
          `Customer-facing answer:`;
        try {
          // COST AUDIT (docs/cost-accounting-audit.md): policy-answer synthesis
          // is an auxiliary Haiku call NOT separately metered into ChatUsage.
          // Covered by the estimator's documented SIDE_CALL_OVERHEAD allowance.
          const r = await anthropic.messages.create({
            model: HAIKU_MODEL,
            max_tokens: 220,
            messages: [{ role: "user", content: prompt }],
          });
          const text = r?.content?.[0]?.text?.trim() || "";
          return text;
        } catch (err) {
          console.warn(`[policy-engine] synth haiku failed: ${err?.message || err}`);
          return null;
        }
      }
    : null;

  let out;
  try {
    out = await runPolicyTurn(ctx, { retrievedChunks, synthesizeFn });
  } catch (err) {
    console.error(`[policy-engine] runPolicyTurn threw: ${err?.stack || err?.message || err}`);
    return null;
  }
  if (!out) return null;
  if (out.decline) return { declined: true, diagnostics: out.diagnostics };

  // Emit text → products(empty) → link? → suggestions? → done.
  //
  // Widget contract: CTA renders as `{ type:"link", url, label }`,
  // NOT `{ type:"cta", cta: {...} }`. Verified against
  // hajirai-chat-widget.js — only type:"link" triggers
  // linkCTA={url,label} which the UI renders as a button. Live
  // failure 2026-06-03: policy answers shipped with the wrong
  // shape and the button never rendered.
  //
  // Follow-up suggestions (quick-reply chips) come from the
  // policy engine's deterministic per-intent list — no LLM call.
  const text = String(out.answerText || "").trim();
  controller.enqueue(encoder.encode(sseChunk({ type: "text", text })));
  controller.enqueue(encoder.encode(sseChunk({ type: "products", products: [] })));
  if (out.cta && out.cta.url) {
    // Reuse normalizeContactLabel so the fallback path doesn't
    // double-prefix "Contact" when the merchant's supportLabel
    // already starts with "Contact" (live failure 2026-06-03:
    // button read "Contact Contact customer service").
    const { normalizeContactLabel } = await import("../lib/policy-engine.server");
    controller.enqueue(encoder.encode(sseChunk({
      type: "link",
      url: out.cta.url,
      label: out.cta.label || normalizeContactLabel(ctx.supportLabel),
    })));
  }
  if (Array.isArray(out.followUps) && out.followUps.length > 0) {
    controller.enqueue(encoder.encode(sseChunk({
      type: "suggestions",
      questions: out.followUps,
    })));
  }
  controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
  return {
    handled: true,
    answerText: text,
    diagnostics: { ...out.diagnostics, ctaUrl: out.cta?.url || null },
  };
}


// Does THIS turn carry a concrete commerce constraint a product search can use
// (named product / focus / category / color / condition / sale / price cap)?
// A forced card search must NOT run from a raw non-product sentence with none of
// these — that's what surfaced "Mila Low Boot" under a generic sizing question.
function turnHasConcreteCommerceConstraint(ctx) {
  const plan = ctx?.turnPlan || {};
  if (Array.isArray(plan.namedFamilies) && plan.namedFamilies.length > 0) return true;
  if (ctx?.focusProduct) return true;
  const msg = String(ctx?.latestUserMessage || "");
  if (!msg.trim()) return false;
  // sale / discount / price
  if (/\b(on\s+sale|sale|deals?|discount(?:ed)?|clearance|markdown[s]?|promo(?:tion)?s?|cheap(?:er)?|under\s+\$?\d|below\s+\$?\d|less\s+than\s+\$?\d)\b/i.test(msg)) return true;
  // color
  if (/\b(black|white|ivory|cream|navy|blue|red|burgundy|pink|blush|rose|coral|green|olive|tan|beige|nude|taupe|brown|cognac|bronze|gold|silver|grey|gray|charcoal|champagne|purple|plum|yellow|orange)\b/i.test(msg)) return true;
  // condition / use-case
  if (/\b(plantar|fasciitis|arch|heel|bunion|neuroma|diabetic|neuropathy|overpronation|flat\s+feet|high\s+arch|standing|walking|running|work|travel|wedding|nursing)\b/i.test(msg)) return true;
  // catalog category (merchant-configured) OR generic footwear category words
  const cats = Array.isArray(ctx?.catalogCategories) ? ctx.catalogCategories : [];
  for (const c of cats) {
    const norm = String(c || "").trim().toLowerCase().replace(/s$/, "");
    if (norm.length >= 3) { try { if (new RegExp(`\\b${norm}s?\\b`, "i").test(msg)) return true; } catch { /* skip */ } }
  }
  if (/\b(sandals?|sneakers?|boots?|shoes?|footwear|wedges?|flats?|heels?|slides?|loafers?|mules?|clogs?|slippers?|sock[s]?|orthotic[s]?|insole[s]?)\b/i.test(msg)) return true;
  return false;
}

// The forced-card-search gate (the most important invariant): a plan-driven
// forced search may run ONLY for a concrete commerce workflow WITH a concrete
// constraint, and never when the assistant's own answer is a clarifying
// question. Refuses for clarification / sizing_help / policy_account outright.
function forcedSearchAllowed({ ctx, text }) {
  const plan = ctx?.turnPlan;
  const wf = plan?.workflow;
  if (wf === "clarification" || wf === "sizing_help" || wf === "policy_account") return false;
  // TURNPLAN AUTHORITY: an answer workflow that requires a search AND requires
  // product display may NEVER be refused by the legacy concrete-constraint
  // heuristic (or the clarifier-shape check) below. TurnPlan owns the decision;
  // downstream only enforces it. Refusing here is a legacy owner silently
  // re-deciding a turn TurnPlan already pinned to searchRequired + display=show.
  if (isAnswerWorkflow(plan) && plan?.searchRequired === true && planForcesProductDisplay(plan)) {
    return true;
  }
  if (text && looksLikeClarifyingQuestion(text)) return false;
  return turnHasConcreteCommerceConstraint(ctx);
}

function shouldAttachProductCardsForTurn({ text, ctx, recommenderAskedForMoreInfo, orderTrackingTurn }) {
  const latest = ctx?.latestUserMessage || "";
  // Order-status / tracking / returns turns are answered in text (order
  // details + tracking link). Never force a product search onto them.
  // Prod trace 2026-06-23: "check the status of my order" force-searched
  // the tracking sentence and surfaced a $0.00 "VIP Processing" SKU as a
  // product card. When get_customer_orders ran this turn, no cards.
  if (orderTrackingTurn) return false;
  // Simple acknowledgments ("yes", "thanks", "ok", "sure", etc.) never
  // attach products even if the prior assistant text looks pitch-y.
  // Live trace 2026-06-08: customer typed "yes" after a referral-share
  // offer. LLM wrote "Perfect! Share your link and earn $20..." which
  // matched the product-pitch regex (contains "perfect" + "here are"),
  // so the postprocessor forced a search with query="yes" and attached
  // 6 random orthotic cards under a referral message.
  if (SIMPLE_PATTERN.test(String(latest).trim())) return false;
  // Knowledge / info questions: customer asked about technologies,
  // materials, brand story, etc. The answer is a text-only knowledge
  // reply — attaching random product cards under a tech-list answer
  // pollutes the response. Live trace 2026-06-08: "beside BioRocker
  // and UltraSky, what other technologies your shoes has?" → LLM
  // listed Lynco/memory foam/etc., but the system attached 10 random
  // footwear cards from a category-locked search.
  // Mirror of the engine's KNOWLEDGE_QUESTION_RE — keep the two in
  // sync when adding new patterns.
  if (
    /\b(?:what\s+(?:other|else|kind\s+of|kinds\s+of|sort\s+of|sorts\s+of|type\s+of|types\s+of)\s+(?:technolog|material|feature|brand|tech|spec|fabric|sole|midsole|footbed|insole|method|system|certification)|what\s+(?:technolog|material|feature|brand|tech)|what\s+(?:is|are)\s+(?:your|the)\s+(?:technolog|material|feature|brand|tech|story|mission)|tell\s+me\s+about\s+(?:your|the|aetrex)|how\s+(?:does|do)\s+(?:your|the|biorocker|ultrasky|aetrex)|why\s+(?:aetrex|your|do\s+you)|beside[s]?\s+[A-Z][a-z]+|besides\s+[A-Z][a-z]+|other\s+than\s+[A-Z][a-z]+|explain\s+(?:your|the|biorocker|ultrasky|how)|what\s+makes\s+(?:your|aetrex|biorocker|ultrasky))\b/i
      .test(latest)
  ) return false;
  const compound = isCompoundPolicyProductQuestion(latest);
  const latestIsPolicyOnly = isPolicyOrServiceQuestion(latest) && !compound;
  if (latestIsPolicyOnly || recommenderAskedForMoreInfo) return false;
  // Under llm-owns, the resolver's stale "recommend" verdict must not
  // force cards onto a turn the model answered as text. Live trace
  // 2026-06-10: "Do you price match Amazon?" got 5 orthotic cards
  // attached because memory still said category=orthotics from three
  // turns earlier. The model's own text decides (pitch → attach below).
  if (!llmOwnsTurnActive() && resolverPromisedRecommendation(ctx?.resolverState)) return true;
  if (compound) return true;
  if (!text) return false;
  if (looksLikeClarifyingQuestion(text)) return false;
  return looksLikeProductPitch(text);
}


function softGenderBrowseSearchInput(latestUserMessage = "") {
  const text = String(latestUserMessage || "");
  const lower = text.toLowerCase();
  const input = { query: "shoes", limit: 6 };
  const priceMax = lower.match(/\b(?:under|below|less\s+than)\s+\$?\s*(\d{2,4})\b/);
  if (priceMax) input.priceMax = Number(priceMax[1]);
  if (/\b(?:cheap|cheaper|sale|deals?|discount|on\s+sale)\b/i.test(text)) {
    input.query = "sale shoes";
    input.onSale = true;
  } else if (/\b(?:under|below|less\s+than)\b/i.test(text)) {
    input.query = "shoes";
  } else if (/\b(?:best\s*sellers?|bestsellers?|popular|top\s+rated|favorite)\b/i.test(text)) {
    input.query = "popular shoes";
  } else if (/\b(?:comfort|arch|support|pain|standing|walking)\b/i.test(text)) {
    input.query = "arch support shoes";
  }
  return input;
}

function lastAssistantContent(history) {
  for (let i = (history || []).length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn?.role === "assistant" && turn.content) return String(turn.content);
  }
  return "";
}

function shouldSoftBrowseRefine(latestMessage, history) {
  const latest = String(latestMessage || "");
  const previous = lastAssistantContent(history);
  const previousAskedBroadClarifier =
    /\bwhich styles would you like to browse\b/i.test(previous) ||
    /\bare you shopping for men's or women's\b/i.test(previous) ||
    /\bwhat type of\b/i.test(previous) ||
    /\bwhat kind of\b/i.test(previous);

  if (
    previousAskedBroadClarifier &&
    /\b(?:not\s+sure|don'?t\s+know|do\s+not\s+know|no\s+idea|anything|any\s+style|whatever|surprise\s+me|you\s+choose|browse|options?|gift|wedding|occasion|event|work|office|walking|travel|trip)\b/i.test(latest)
  ) {
    return true;
  }

  if (!/\b(?:cheap|cheaper|under|below|less\s+than|sale|deals?|discount)\b/i.test(latest)) return false;
  return /\bnarrow by men's, women's, style, color, or price\b/i.test(previous) ||
    /\bhere are (?:a few|popular|sale|comfort-focused|styles under \$\d+)/i.test(previous);
}

function isOrthoticRecommendationIntent(text = "") {
  const value = String(text || "");
  const namesOrthotic = /\b(?:orthotics?|orhtotics?|orthtoics?|insoles?|inserts?|footbeds?)\b/i.test(value);
  const namesClinicalNeed = /\b(?:overpronation|flat\s+feet|fallen\s+arches|plantar\s+fasciitis|heel\s+pain|arch\s+pain|metatarsalgia|ball[-\s]?of[-\s]?foot|morton's|neuropathy|diabetic|high\s+arch|low\s+arch)\b/i.test(value);
  const asksRecommendation = /\b(?:need|recommend|best|which|what\s+should|help|for)\b/i.test(value);
  return namesOrthotic && (namesClinicalNeed || asksRecommendation);
}

// How many prior assistant turns were soft-browse starter responses.
// Drives text rotation: 0 = original copy, 1 = "different set", 2 =
// "another angle", 3+ = "new mix / final nudge". Each variant looks
// distinct enough that a customer who keeps saying "something else"
// doesn't see word-for-word repeats — and the text moves from
// invitational to more directly nudging for a constraint.
function priorBrowseCount(history) {
  let n = 0;
  for (const turn of history || []) {
    if (turn?.role !== "assistant" || typeof turn.content !== "string") continue;
    if (
      /\bnarrow by men's, women's, style, color,? or (?:a specific budget|price|color)\b/i.test(turn.content) ||
      /\bhere are (?:a few|popular|sale|comfort-focused|styles under \$\d+|a different set)/i.test(turn.content) ||
      /\bhere's a different set\b/i.test(turn.content) ||
      /\bdifferent take\b|\banother angle\b|\bnew mix\b/i.test(turn.content)
    ) {
      n += 1;
    }
  }
  return n;
}

// Handles already shown across the entire conversation — excluded from
// a repeat soft-browse so "show me something else" produces a genuinely
// different set instead of recycling old cards. Cumulative across all
// assistant turns (not just the most recent). The old version only
// checked the last turn, so the 3rd browse silently repeated browse
// #1's cards — that's the regression the hunter caught.
function priorlyShownHandles(ctx) {
  const out = new Set();
  const harvest = (cards) => {
    for (const c of Array.isArray(cards) ? cards : []) {
      const key = c?.handle || c?.title;
      if (key) out.add(String(key));
    }
  };
  harvest(ctx?.priorProductCards);
  harvest(ctx?.allPriorProductCards);
  return out;
}

function interleaveUniqueCards(groups, limit) {
  const out = [];
  const seen = new Set();
  const maxLen = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < maxLen; i += 1) {
    for (const group of groups) {
      const card = group[i];
      const key = card?.handle || card?.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(card);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

async function fetchSoftBrowseCards({ ctx, input, excludeHandles = null }) {
  const cap = ctx?.productCardCap || 3;
  // Fetch a wider pool than we display so excluded (already-shown)
  // cards can be filtered out and still leave a full set to show.
  const fetchLimit = Math.max(cap * 3, input?.limit || 6);
  const searchInput = { ...input, limit: fetchLimit };
  const exclude = excludeHandles instanceof Set ? excludeHandles : null;
  const filterExcluded = (cards) => {
    if (!exclude || exclude.size === 0) return cards;
    const kept = cards.filter((c) => !exclude.has(String(c?.handle || c?.title)));
    // If excluding everything would leave nothing, fall back to the
    // unfiltered set — showing repeats beats showing an empty browse.
    return kept.length > 0 ? kept : cards;
  };
  const hasGenderScope = Boolean(ctx?.sessionGender || searchInput?.filters?.gender);
  if (hasGenderScope) {
    const result = await dispatchTool("search_products", searchInput, ctx);
    return filterExcluded(extractProductCards("search_products", result, ctx)).slice(0, cap);
  }

  const withGender = (gender) => ({
    ...searchInput,
    filters: { ...(searchInput.filters || {}), gender },
  });
  const [women, men] = await Promise.all([
    dispatchTool("search_products", withGender("women"), ctx),
    dispatchTool("search_products", withGender("men"), ctx),
  ]);
  const mixed = interleaveUniqueCards(
    [
      filterExcluded(extractProductCards("search_products", women, ctx)),
      filterExcluded(extractProductCards("search_products", men, ctx)),
    ],
    cap,
  );
  if (mixed.length > 0) return mixed;

  const fallback = await dispatchTool("search_products", searchInput, ctx);
  return filterExcluded(extractProductCards("search_products", fallback, ctx)).slice(0, cap);
}

async function emitSoftGenderGateBrowse({ ctx, controller, encoder }) {
  const input = softGenderBrowseSearchInput(ctx?.latestUserMessage || "");
  // On a repeat browse, vary the text AND rotate past already-shown
  // cards (cumulative across all prior assistant turns, not just the
  // last one) so "show me something else" doesn't recycle old cards.
  const repeatIndex = priorBrowseCount(ctx?.messages);
  const repeated = repeatIndex > 0;
  const excludeHandles = repeated ? priorlyShownHandles(ctx) : null;
  const cards = await fetchSoftBrowseCards({ ctx, input, excludeHandles });
  const text = buildSoftBrowseFallbackText({ input, hasProducts: cards.length > 0, repeated, repeatIndex });

  controller.enqueue(encoder.encode(sseChunk({ type: "text", text })));
  controller.enqueue(encoder.encode(sseChunk({ type: "products", products: cards })));
  controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
  console.log(
    `[chat] ${ctx.shop} soft-gender-gate browse emitted ` +
      `query=${JSON.stringify(input.query)} poolSize=${cards.length} repeatIndex=${repeatIndex} excluded=${excludeHandles ? excludeHandles.size : 0}`,
  );
  return cards.length;
}

// Generic brand-mention detector. When the customer asks "do you have
// anything from <Brand>?" / "by <Brand>" / "made by <Brand>" / "the
// <Brand> brand", the AI's "we don't carry <Brand>" is a legitimate
// answer about brand availability — not a hallucinated denial.
// Without this guard, denial-recovery would fire and search the catalog
// for random products that have nothing to do with the brand.
//
// No hardcoded brand list — works for ANY merchant. Detects the
// structural pattern: lead word ("from"/"by"/"made by"/"brand") +
// capitalized proper noun. The capital-letter check is what filters
// out non-brand uses like "from your spring collection" or "by mail".
//
// If the merchant's OWN brand is mentioned, the AI wouldn't deny so
// recovery wouldn't trigger — this guard only fires AFTER a denial
// is detected, so it's safe.
const BRAND_LEAD_RE = /\b(?:from|by|made\s+by|brand|brands)\s+(\S+)/gi;
function hasCompetitorBrandMention(text) {
  if (!text) return false;
  let m;
  BRAND_LEAD_RE.lastIndex = 0;
  while ((m = BRAND_LEAD_RE.exec(text)) !== null) {
    const candidate = m[1] || "";
    // Brand-like: starts with capital letter + at least 1 more letter.
    // Strips punctuation off the end ("Nike?" → "Nike").
    const cleaned = candidate.replace(/[^\w].*$/, "");
    if (/^[A-Z][A-Za-z]/.test(cleaned)) return true;
    if (BRAND_LEAD_RE.lastIndex === m.index) BRAND_LEAD_RE.lastIndex += 1;
  }
  return false;
}
// containsAvailabilityDenial lives in app/lib/chat-helpers.server.js so
// the test suite can import it without dragging the route loader graph.

async function runAgenticLoop({ anthropic, model, systemPrompt, messages, ctx, controller, encoder, promptCaching, tools, promptStableLength = 0, forceNoTools = false, deferTextEmit = false }) {
  const totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let toolCallCount = 0;
  // Track whether ANY recommend_* tool fired this turn. Used to
  // suppress follow-up suggestions on recommendation turns —
  // production showed Haiku generating "Do you have X in other
  // styles?" / "Would a different color work?" follow-ups that the
  // recommender resolver cannot fulfill, leading to a dead-end.
  let recommenderInvokedThisTurn = false;
  let productSearchAttempted = false;
  // Quality signals — set when a fact-validator catches the model
  // reasoning WRONG this turn (not a cosmetic fix). These drive the
  // Sonnet→Opus reactive escalation at the call site: when a weaker
  // model produces a denial/hallucination/garbage that code had to
  // patch into a degraded fallback, re-running on a stronger model
  // usually yields a genuinely correct answer. Cosmetic fixes (dedup,
  // reflow, clean color-rewrite) deliberately do NOT set these.
  const qualitySignals = {
    definitionalHallucination: false,
    falseDenial: false,
    emptyAfterStrips: false,
  };
  // Set when a recommender tool returned needMoreInfo (the gate
  // detected required attributes were missing and instructed the
  // LLM to ask the customer first). When this fires, the AI's
  // next-hop text is a clarifying question — not a failed pitch —
  // so the empty-pool repair / definitional-hallucination strips
  // below must not wipe it.
  let recommenderAskedForMoreInfo = false;
  // Track tool calls per turn so post-emit guards can validate the
  // AI's claims against what was actually queried. Specifically,
  // stock-availability claims ("currently available in size 9") must
  // be backed by a get_product_details call this turn — without that,
  // the size statement is hallucinated. Set wins all tools by name.
  const toolsCalledThisTurn = new Set();
  // Tracks recommender tools that have already returned a hard,
  // self-explaining error this turn (sandal-incompatibility, kids-
  // gender no-match, etc). The agentic loop short-circuits any
  // subsequent identical-tool call to the same cached error, so the
  // LLM can't burn 2-3 hops re-issuing the same losing call.
  // Production showed three sequential recommend_orthotic calls all
  // hitting the sandal-incompat guard in one turn — the LLM ignored
  // the redirect instruction and tried again. Cache breaks the loop.
  const recommenderHardErrorsThisTurn = new Map();
  const allProductPool = new Map();
  const excludedFamilies = new Set();
  const excludedHandles = new Set();
  // Product handles the fit tool focused on. When present, the final card
  // display filters to just these — a size question about "Miles" should
  // only show the Miles card, not Elise/Dylan/etc. that happened to match
  // the search query on generic words like "arch support sneaker".
  const focusedHandles = new Set();
  let fullResponseText = "";
  const outboundLinks = [];
  let finalProductCards = [];
  let hasKlaviyoForm = false;
  // Evidence lock (answer workflows). The first product search the model runs
  // this turn — after plan enforcement — is the authoritative family query.
  // The forced-card fallback reuses it instead of stale session memory so the
  // displayed cards stay locked to the same family as the answer text.
  let turnEvidenceSearchInput = null;


  // Two-block system when the prompt builder marked a stable prefix:
  // the breakpoint goes on the stable-per-shop block so it's a cheap
  // cache READ on every warm turn, while the per-turn suffix (RAG,
  // scoped lists, VIP, injected directives) is billed as plain input
  // instead of invalidating and re-WRITING the whole prompt. Cache
  // writes were ~60% of the LLM bill before this split.
  const stableLen =
    Number.isFinite(promptStableLength) &&
    promptStableLength > 0 &&
    promptStableLength < systemPrompt.length
      ? promptStableLength
      : 0;
  // Cache TTL: the stable prefix is identical across every turn for
  // a shop and changes only when admin settings or catalog shape do
  // (not per-request). 5-min ephemeral writes get re-paid during any
  // gap longer than 5 min — common overnight, weekend, low-traffic
  // hours. 1-hour TTL costs 2× per write (vs 1.25× for 5-min) but
  // breaks even after just three reads on the same write, which is
  // typical even in modest traffic. For high-traffic shops the cache
  // stays warm under 5-min already, so the 1-hour TTL is strictly
  // protective during quiet periods.
  const system = promptCaching
    ? (stableLen > 0
        ? [
            { type: "text", text: systemPrompt.slice(0, stableLen), cache_control: { type: "ephemeral", ttl: "1h" } },
            { type: "text", text: systemPrompt.slice(stableLen) },
          ]
        : [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } }])
    : systemPrompt;

  const activeTools = tools || TOOLS;

  // Deterministic non-search turns must NOT call tools. The plan already decided
  // there's no search to run: clarification (a bare "yes" / vague opener), and
  // the re-pin / selection / cart turns whose cards come straight from prior
  // evidence — display_recovery, product_focus, cart_handoff. Letting the model
  // search anyway wastes a hop and produces a stray card the deterministic owner
  // then has to overwrite (live trace 2026-06-30: display_recovery search=false,
  // yet the model searched "walking supportive shoes" before evidence-plan
  // re-pinned the prior cards). Force tool_choice:none for the whole turn.
  if (workflowDisablesTools(ctx?.turnPlan?.workflow)) forceNoTools = true;

  // Broad gender browse ("Show me men's options") is a DETERMINISTIC owner: the
  // gender-only pin below runs the one correct search itself. Let the model keep
  // tools and it re-searches the PRIOR cards' categories for the new gender
  // (gender=men category="wedges heels" → women-only → mismatch → zero cards →
  // "we don't carry men's footwear"; live trace 2026-06-30). Force tools off so
  // the stale-category search can never happen in the first place.
  if (ctx?.turnPlan?.workflow === "browse" && isBroadGenderRequest(ctx?.latestUserMessage || "")) {
    forceNoTools = true;
    console.log(`[broad-gender-browse] tools forced OFF — deterministic gender-only pin owns this turn (msg="${String(ctx?.latestUserMessage || "").slice(0, 60)}")`);
  }

  // Tracks the final hop's stop_reason. If the loop exits with this still
  // === "tool_use", the model was cut off by the hop budget mid-tool-use
  // (it wanted to call another tool) — any text it left is an incomplete
  // preamble, NOT a finished answer to the customer.
  let lastStopReason = null;

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    // If the previous hop emitted text and this hop is about to emit more,
    // insert a paragraph break so the two streamed chunks don't run together
    // as "...you!Here are..." in the rendered message.
    if (hop > 0 && fullResponseText && !/\s$/.test(fullResponseText)) {
      fullResponseText += "\n\n";
    }

    const hopStart = Date.now();
    // Retry the stream init only when this hop has not yet contributed
    // any text — if we already emitted tokens for THIS hop we can't
    // safely retry without duplicating output to the customer. The
    // retry covers the common "Anthropic returned 503/429 on connect"
    // failure mode invisibly.
    const textBeforeHop = fullResponseText.length;
    const final = await withAnthropicRetry(
      async () => {
        if (fullResponseText.length > textBeforeHop) {
          // Hop already streamed tokens once; cannot safely retry.
          // Throw a marker error that withAnthropicRetry classifies as
          // non-retryable to bail out cleanly.
          const err = new Error("partial-stream-no-retry");
          err.status = 0;
          throw err;
        }
        const stream = anthropic.messages.stream({
          model,
          max_tokens: MAX_TOKENS,
          system,
          tools: activeTools,
          // Rewrite-only mode (style-only validator retry): forbid tool
          // calls so the model reshapes its existing draft from the tool
          // results already in `messages` — no expensive re-search.
          ...(forceNoTools ? { tool_choice: { type: "none" } } : {}),
          messages,
        });
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            fullResponseText += event.delta.text;
          }
        }
        return await stream.finalMessage();
      },
      { label: "chat-stream", maxRetries: 3 },
    );
    addUsage(totalUsage, final.usage || {});
    console.log(`[chat] hop=${hop} stop=${final.stop_reason} ms=${Date.now() - hopStart} textLen=${fullResponseText.length}`);
    lastStopReason = final.stop_reason;

    if (final.stop_reason !== "tool_use") {
      break;
    }

    const toolUses = final.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) break;

    toolCallCount += toolUses.length;
    for (const u of toolUses) toolsCalledThisTurn.add(u.name);
    if (toolUses.some((u) =>
      u.name === "search_products" ||
      u.name === "get_product_details" ||
      u.name === "lookup_sku" ||
      u.name === "find_similar_products" ||
      // Smart Recommender tools count as a successful search — they
      // return one deterministic master SKU + product card. Without
      // this, the recovery-search safety net below wrongly fires on
      // turns where recommend_<intent> already produced the card,
      // and overwrites it with an unrelated search_products result.
      u.name.startsWith("recommend_")
    )) {
      productSearchAttempted = true;
    }

    // Pre-load merchant color values once per request so the
    // injectStructuredColorFilter rewrite can match without a DB
    // round-trip per tool call.
    if (ctx._merchantColors === undefined && toolUses.some((u) => u.name === "search_products")) {
      await loadMerchantColors(ctx);
    }

    // Tool-call rewrite pipeline: structural fixes B, C, D.
    // Runs the customer's literal latest message against each tool
    // input and corrects mismatches (stale carry-over category,
    // multi-SKU comparison, free-text color → structured filter)
    // before dispatch. Falls through cleanly when no rewrite needed.
    const rewrittenUses = await Promise.all(
      toolUses.map((u) => rewriteToolCall(u, ctx)),
    );

    // Evidence lock: capture the FIRST plan-enforced product search this turn
    // for answer workflows. Its query already names the family the customer
    // asked about, so the forced-card fallback can reuse it instead of stale
    // memory (the root of the "Savannah text, sneaker cards" contamination).
    if (!turnEvidenceSearchInput && isAnswerWorkflow(ctx?.turnPlan)) {
      const firstSearch = rewrittenUses.find((u) => u && u.name === "search_products" && u.input);
      if (firstSearch) {
        turnEvidenceSearchInput = { query: firstSearch.input.query || "", filters: { ...(firstSearch.input.filters || {}) } };
      }
    }

    const results = await Promise.all(
      rewrittenUses.map((u) => {
        // Short-circuit repeat recommender calls that already returned
        // a hard error this turn. Without this, the LLM loops on the
        // sandal-incompatibility guard 2-3 times, each call adding
        // ~1-3s and ~5k tokens before the LLM gives up and replies in
        // text. The cached payload swaps the verbose redirect for a
        // terse "stop calling" instruction the LLM can't misread.
        if (u.name && u.name.startsWith("recommend_") && recommenderHardErrorsThisTurn.has(u.name)) {
          const prior = recommenderHardErrorsThisTurn.get(u.name);
          console.log(
            `[recommender] short-circuit: ${u.name} already returned hard error this turn (${prior.kind}); ` +
              `skipping resolver, returning stop-instruction`,
          );
          return Promise.resolve({
            error: prior.error,
            instruction:
              `STOP calling ${u.name}. It already returned this exact error this turn. ` +
              `Reply to the customer in plain TEXT now using the redirect already provided. ` +
              `Do NOT invoke any recommend_* tool again this turn.`,
            stopCalling: true,
          });
        }
        return executeTool(u.name, u.input, ctx);
      }),
    );

    // Cache hard errors from recommender tools so any further calls
    // in the SAME turn (next hop) get the short-circuit above.
    for (let i = 0; i < rewrittenUses.length; i++) {
      const u = rewrittenUses[i];
      const r = results[i];
      if (!u || !u.name || !u.name.startsWith("recommend_")) continue;
      recommenderInvokedThisTurn = true;
      if (!r || r.stopCalling) continue;
      if (r.sandalIncompatible || (r.error && !r.needMoreInfo)) {
        const kind = r.sandalIncompatible
          ? "sandal-incompat"
          : r.missingSpecialty ? "missing-specialty" : "error";
        recommenderHardErrorsThisTurn.set(u.name, { kind, error: r.error });
      }
    }

    // Mutate the messages-array view so the AI sees its own corrected
    // tool calls (and uses them when narrating in the next hop).
    for (let i = 0; i < toolUses.length; i++) {
      if (rewrittenUses[i] !== toolUses[i]) {
        toolUses[i].input = rewrittenUses[i].input;
        toolUses[i].name = rewrittenUses[i].name;
      }
    }

    let hopHasProducts = false;
    for (let i = 0; i < toolUses.length; i++) {
      const u = toolUses[i];
      const r = results[i];
      if (u.name.startsWith("recommend_") && r && r.needMoreInfo === true) {
        recommenderAskedForMoreInfo = true;
      }
      if (u.name === "find_similar_products" && r && !r.error && r.reference) {
        if (r.reference.handle) excludedHandles.add(String(r.reference.handle).toLowerCase());
        const fam = titleStyleFamily(r.reference.title || "");
        if (fam) excludedFamilies.add(fam);
        // When find_similar_products resolved a reference but found
        // ZERO matching siblings (config gap, narrow similarity
        // attributes, or the catalog genuinely has no peers), reset
        // productSearchAttempted so the recovery hop downstream gets
        // a chance to run a generic search_products with the latest
        // user message. Without this, the AI emits an empty reply
        // ("same support as carly" → no text, no cards) because the
        // attempted-flag blocks the safety net.
        if (!Array.isArray(r.products) || r.products.length === 0) {
          console.log(
            `[chat] ${ctx.shop} find_similar_products returned zero products for ` +
              `ref=${r.reference.handle || "?"} — letting recovery hop run`,
          );
          productSearchAttempted = false;
        }
      }
      if (u.name === "get_fit_recommendation" && r && !r.error && r.recommendation?.shouldDisplay) {
        if (r.handle) focusedHandles.add(String(r.handle).toLowerCase());
        const display = typeof ctx.fitPredictorConfig?.display === "string" ? ctx.fitPredictorConfig.display : "bar";
        controller.enqueue(encoder.encode(sseChunk({
          type: "fit_report",
          handle: r.handle,
          productTitle: r.productTitle,
          recommendedSize: r.recommendation.recommendedSize,
          confidence: r.recommendation.confidence,
          reasons: r.recommendation.reasons || [],
          sizesAvailable: r.recommendation.sizesAvailable || [],
          display,
        })));
      }
      const cards = extractProductCards(u.name, r, ctx);
      for (const c of cards) {
        const key = c.handle || c.title;
        if (!allProductPool.has(key)) {
          allProductPool.set(key, c);
          hopHasProducts = true;
        }
      }
    }

    messages.push({ role: "assistant", content: final.content });
    messages.push({
      role: "user",
      content: toolUses.map((u, i) => {
        const payload = results[i] ?? {};
        if (hopHasProducts && (
          u.name === "search_products" ||
          u.name === "get_product_details" ||
          u.name === "lookup_sku" ||
          u.name === "find_similar_products" ||
          u.name.startsWith("recommend_")
        )) {
          payload._display = ADVISORY_INTENT_RE.test(ctx.userText || "")
            ? "Product card(s) are shown automatically. Do NOT list products with links or repeat SKUs/handles. The customer is asking for a SUITABILITY JUDGMENT, not a product list — answer their actual question directly in 2-4 sentences: say whether this product fits their stated use (activity, duration, climate/environment), name the honest tradeoff, and only then point to a better-suited alternative if one genuinely applies. Recommend like a knowledgeable salesperson, not a catalog blurb."
            : "Product card is shown automatically. Do NOT list products with links or repeat the SKU/handle in your text. Write a brief 1-2 sentence summary explaining why this fits.";
        }
        return {
          type: "tool_result",
          tool_use_id: u.id,
          content: JSON.stringify(payload),
        };
      }),
    });
  }

  let initialPool = Array.from(allProductPool.values());

  // When the model exhausts the hop budget while still wanting another tool
  // (lastStopReason === "tool_use"), whatever text it streamed is an
  // incomplete preamble before that never-made tool call — not a finished
  // answer. If that fragment is unsalvageable (would be replaced downstream
  // by the generic "Here are the matching styles" caption), discard it and
  // fall through to the answer-only wrap-up so the customer's actual
  // question gets answered from the tool results already gathered. Live
  // trace 2026-06-25: "will the Jillian hold up for all-day walking?" burned
  // all 3 hops on searches, left a 198-char dangling preamble, and emitted a
  // 37-char canned caption instead of an answer.
  const budgetExhausted = lastStopReason === "tool_use";
  if (budgetExhausted && fullResponseText && initialPool.length > 0) {
    const completeness = ensureCompleteCustomerText({ text: fullResponseText });
    if (completeness.reason === "fallback_after_dangling" || completeness.reason === "empty") {
      console.log(
        `[chat] ${ctx.shop} hop budget exhausted with incomplete preamble (${fullResponseText.length} chars) — regenerating final answer`,
      );
      fullResponseText = "";
    }
  }

  if (!fullResponseText && initialPool.length > 0) {
    // Wrap-up call is safe to retry — no partial output yet.
    const wrap = await withAnthropicRetry(
      () => anthropic.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        tools: TOOLS,
        tool_choice: { type: "none" },
        messages,
      }),
      { label: "chat-wrap", maxRetries: 2 },
    );
    addUsage(totalUsage, wrap.usage || {});

    for (const block of wrap.content) {
      if (block.type === "text" && block.text) {
        fullResponseText += block.text;
      }
    }
  }

  if (fullResponseText) {
    const poolForCheck = Array.from(allProductPool.values());
    const orphanSkus = extractOrphanSkus(fullResponseText, poolForCheck);
    if (orphanSkus.length > 0) {
      const recoveredSkus = new Set();
      try {
        const recovery = await dispatchTool("lookup_sku", { skus: orphanSkus.slice(0, 10) }, ctx);
        toolCallCount += 1;
        const newCards = extractProductCards("lookup_sku", recovery, ctx);
        for (const card of newCards) {
          const key = card.handle || card.title;
          if (!allProductPool.has(key)) allProductPool.set(key, card);
          for (const s of skusFromCardText(card.title)) recoveredSkus.add(s);
          for (const s of skusFromCardText(card.handle)) recoveredSkus.add(s);
        }
        if (recovery && Array.isArray(recovery.found)) {
          for (const f of recovery.found) {
            if (f?.sku) recoveredSkus.add(String(f.sku).toUpperCase());
          }
        }
      } catch (err) {
        console.error("[chat] SKU recovery failed:", err?.message || err);
      }
      const stillMissing = orphanSkus.filter((s) => !recoveredSkus.has(s));
      if (stillMissing.length > 0) {
        fullResponseText = stripMissingSkus(fullResponseText, stillMissing);
      }
    }
  }

  let supportCTA = null;
  // Live-chat handoff CTA (rendered by the widget as a button that opens
  // Zendesk/Intercom/Gorgias, Support Hub URL as fallback). Set by the handoff
  // gate; emitted as an SSE support_cta event, never the plain link anchor.
  let supportHandoffCta = null;
  if (fullResponseText && ctx.supportUrl) {
    const result = extractSupportCTA(fullResponseText, ctx.supportUrl, ctx.supportLabel);
    fullResponseText = result.text;
    supportCTA = result.cta;

    if (!supportCTA) {
      // Scope support-trigger detection to the LATEST user message, not
      // the full conversation. Without this, any historical mention of
      // "exchange", "refund", "return policy", "my order", etc. ANYWHERE
      // earlier in the chat keeps gluing the Visit Support Hub button to
      // every subsequent reply — even chip-only gating questions like
      // "What shoes will your dad wear them in?".
      const userText = ctx.userText || "";
      const aiText = fullResponseText || "";
      const userAskedSupport = /\b(contact|reach|talk to|speak (to|with)|get (a )?hold of|how do i .{0,20}(contact|reach))\b.{0,40}\b(customer|support|service|care|team|human|agent|representative|rep|person|someone)\b/i.test(userText)
        || /\b(customer (service|care|support)|support (hub|team)|return policy|refund|exchange|my order|order status|shipping issue|problem with my)\b/i.test(userText);
      // Tightened: only fires when AI explicitly redirects to support, not
      // on generic conversational phrases ('happy to help', 'our team', etc.)
      // that legitimately appear in normal product replies.
      const aiMentionsSupport = /\b(support team|customer service|customer care|reach out (to )?(our |the )?(team|support|customer service|customer care)|contact (our|the) (team|support|customer service|customer care))\b/i.test(aiText);
      if (userAskedSupport || aiMentionsSupport) {
        const defaultOldLabel = "Contact customer service";
        const label = ctx.supportLabel && ctx.supportLabel.trim() && ctx.supportLabel.trim() !== defaultOldLabel
          ? ctx.supportLabel.trim()
          : "Visit Support Hub";
        supportCTA = { url: ctx.supportUrl, label };
      }
    }
  }
  // Commerce turns never punt to Support. A sale-browse turn that wrongly
  // produced "Visit Support Hub" (Failure B) must show sale products, not a
  // support link.
  if (supportCTA && (ctx?.turnPlan?.workflow === "sale_browse" || ctx?.turnPlan?.workflow === "comparison")) {
    console.log(`[chat] support CTA suppressed: ${ctx.turnPlan.workflow} is a commerce turn (show products, not Support)`);
    supportCTA = null;
  }

  // Recovery hop — if the AI shipped pitch text without ever calling
  // search_products, but the customer's history mentions a condition
  // (plantar fasciitis, bunion, etc.) or occasion (trip, walking),
  // bypass the AI and run the search ourselves. Replace the pitch
  // text with neutral framing. Deterministic, no extra API call.
  //
  // Without this, the empty-pool repair below wipes the pitch text
  // and renders a dead-end fallback — even when the customer gave
  // us everything we needed to find a real product.
  // Skip recovery if the AI's text ends with a clarifying question
  // (e.g. "Are these for men or women?"). That's the recommender-
  // flow elicitation step and shouldn't be overridden by a search.
  const aiAskedClarifyingQuestion = (() => {
    const t = String(fullResponseText || "").trim();
    if (!t) return false;
    if (t.endsWith("?")) return true;
    const lastChunk = t.split(/[.!]\s+/).pop() || "";
    return /\?\s*$/.test(lastChunk.trim());
  })();
  if (
    !productAuthorityModeEnabled() &&
    !productSearchAttempted &&
    looksLikeProductPitch(fullResponseText) &&
    allProductPool.size === 0 &&
    !aiAskedClarifyingQuestion
  ) {
    // Use the latest user message only — ctx.userText concatenates the
    // entire conversation history, so on a pivot (e.g. user said
    // "morton's neuroma" two turns ago, now says "high arch what
    // orthotic"), CONDITION_RE picks up the stale phrase and the
    // recovery search runs the WRONG query. Always recover against
    // what the customer just asked.
    const intent = detectConditionOrOccasion(ctx.latestUserMessage || ctx.userText || "");
    if (intent) {
      console.log(`[chat] recovery search: AI did not call tool, forcing query="${intent.phrase}" (${intent.kind})`);
      try {
        const recovery = await dispatchTool(
          "search_products",
          { query: intent.phrase, limit: intent.kind === "condition" ? 1 : 3 },
          ctx,
        );
        if (recovery && Array.isArray(recovery.products) && recovery.products.length > 0) {
          productSearchAttempted = true;
          for (const p of recovery.products) {
            if (p?.handle && !allProductPool.has(p.handle)) allProductPool.set(p.handle, p);
          }
          fullResponseText = intent.kind === "condition"
            ? `Here's what I'd recommend for ${intent.phrase}.`
            : `Here are some options for ${intent.phrase}.`;
          console.log(`[chat] recovery search: filled pool with ${recovery.products.length} product(s)`);
        } else {
          console.log(`[chat] recovery search: returned 0 products`);
        }
      } catch (err) {
        console.error("[chat] recovery search failed:", err?.message || err);
      }
    }
  }

  const resolverDeniedHonestly =
    ctx.resolverState?.recommended_next_action?.type === "no_match" ||
    (Array.isArray(ctx.resolverState?.impossible_constraints) &&
      ctx.resolverState.impossible_constraints.length > 0);
  if (
    !productAuthorityModeEnabled() &&
    !productSearchAttempted &&
    fullResponseText &&
    containsAvailabilityDenial(fullResponseText) &&
    ctx.latestUserMessage &&
    (!isPolicyOrServiceQuestion(ctx.latestUserMessage) || isCompoundPolicyProductQuestion(ctx.latestUserMessage)) &&
    !hasCompetitorBrandMention(ctx.latestUserMessage) &&
    !resolverDeniedHonestly
  ) {
    console.log(`[chat] denial-recovery: AI denied availability without searching; forcing search of latest user message`);
    try {
      const denialQuery = String(ctx.latestUserMessage || "").slice(0, 200).trim();
      const recovery = await dispatchTool(
        "search_products",
        { query: denialQuery, limit: 6 },
        ctx,
      );
      if (recovery && Array.isArray(recovery.products) && recovery.products.length > 0) {
        productSearchAttempted = true;
        for (const p of recovery.products) {
          if (p?.handle && !allProductPool.has(p.handle)) allProductPool.set(p.handle, p);
        }
        // The AI's denial text is wrong. Replace with a neutral
        // pitch that matches the products we actually found.
        fullResponseText = "Actually, take a look at these — they should be a solid fit for what you're after.";
        console.log(`[chat] denial-recovery: replaced denial with ${recovery.products.length} real product(s)`);
      } else {
        productSearchAttempted = true; // we did try
        console.log(`[chat] denial-recovery: search returned 0 — denial appears accurate`);
      }
    } catch (err) {
      console.error("[chat] denial-recovery failed:", err?.message || err);
    }
  }

  if (!llmOwnsTurnActive() && !productAuthorityModeEnabled() && productSearchAttempted && allProductPool.size > 0 && allProductPool.size <= 2) {
    const userT = String(ctx.userText || "").toLowerCase();
    const namesCategory = Array.isArray(ctx.catalogCategories) && ctx.catalogCategories.some((c) => {
      const norm = String(c || "").trim().toLowerCase().replace(/s$/, "");
      if (!norm || norm.length < 3) return false;
      try { return new RegExp(`\\b${norm}s?\\b`, "i").test(userT); } catch { return false; }
    });
    const broadNeed = detectBroadNeed(userT);
    if (!namesCategory && broadNeed) {
      const catCounts = new Map();
      for (const p of allProductPool.values()) {
        const cat = String(p?._category || p?.category || p?.productType || "").toLowerCase().trim();
        if (cat) catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
      }
      const dominant = [...catCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      console.log(`[chat] auto-broaden trigger: pool=${allProductPool.size} dominant=${dominant || "-"} broad-need=true`);
      try {
        const broaden = await dispatchTool(
          "search_products",
          { query: String(ctx.userText || "").slice(0, 120), limit: 5 },
          ctx,
        );
        if (broaden && Array.isArray(broaden.products)) {
          let added = 0;
          for (const p of broaden.products) {
            if (!p?.handle || allProductPool.has(p.handle)) continue;
            const cat = String(p?._category || p?.category || p?.productType || "").toLowerCase().trim();
            // Skip products from the same dominant category — we want diversity
            if (dominant && cat === dominant) continue;
            allProductPool.set(p.handle, p);
            added++;
            if (added >= 3) break;
          }
          console.log(`[chat] auto-broaden: added ${added} product(s) outside dominant category`);
        }
      } catch (err) {
        console.error("[chat] auto-broaden failed:", err?.message || err);
      }
    }
  }

  // Repeat-clarifier guard: a clarifier for a given slot must never be
  // emitted twice in a row. If this turn would re-ask the same slot the
  // previous clarifier already asked (and we have no products to show),
  // stop asking and show products instead — honoring any scope the
  // customer already established so we don't regress into a generic browse.
  // LEGACY ONLY: under llm-owns-turn the model owns its clarifying
  // questions; this escape was observed (2026-06-10, admin test chat)
  // hijacking an orthotics question and force-showing generic shoe
  // starter cards — exactly the kind of text/card mutation the new
  // engine forbids.
  const currentClarifyingType = detectClarifyingQuestionType(fullResponseText);
  const lastClarifyingType = ctx.sessionMemory?.lastClarifyingQuestion?.type || null;
  if (!llmOwnsTurnActive() && currentClarifyingType && currentClarifyingType === lastClarifyingType && allProductPool.size === 0) {
    try {
      const scoped = scopedProductSearchInput(ctx);
      const hasScope = !!(scoped.scope.gender || scoped.scope.category || scoped.scope.color);
      const input = hasScope ? scoped.input : softGenderBrowseSearchInput(ctx.latestUserMessage || "");
      const repeatIndex = priorBrowseCount(ctx.messages);
      const repeated = repeatIndex > 0;
      const excludeHandles = repeated && !hasScope ? priorlyShownHandles(ctx) : null;
      const cards = hasScope
        ? extractProductCards("search_products", await dispatchTool("search_products", input, ctx), ctx)
        : await fetchSoftBrowseCards({ ctx, input, excludeHandles });
      for (const card of cards) {
        const key = card?.handle || card?.title;
        if (key && !allProductPool.has(key)) allProductPool.set(key, card);
      }
      if (cards.length > 0) {
        productSearchAttempted = true;
        fullResponseText = buildSoftBrowseFallbackText({ input, hasProducts: true, repeated, repeatIndex });
        console.log(`[chat] repeated-clarifier escape: ${currentClarifyingType} → showing ${cards.length} starter product(s) repeatIndex=${repeatIndex}`);
      }
    } catch (err) {
      console.error("[chat] repeated-clarifier escape failed:", err?.message || err);
    }
  }

  const productTurnWantsCards = shouldAttachProductCardsForTurn({
    text: fullResponseText,
    ctx,
    recommenderAskedForMoreInfo,
    orderTrackingTurn: toolsCalledThisTurn.has("get_customer_orders"),
  });
  // TurnPlan search authority. When the plan requires a product search and
  // the model finished without one, we must not ship an unsearched answer —
  // force the scoped plan-driven search (ensureProductTurnCards runs it when
  // shouldAttach is true and the pool is empty). This makes searchRequired
  // deterministic instead of the old warning-only missing_product_lookup.
  // INVARIANT: never force a card search from a raw non-product sentence. A
  // plan-driven forced search runs only for a concrete commerce workflow WITH a
  // concrete constraint and when the answer isn't a clarifying question.
  // REWRITE-ONLY RETRY. When runWithGroundingRetry forces a tools-off rewrite
  // (comparison / evidence-plan, or a style-only fix), the cards were already
  // chosen on a prior attempt and are authoritative. A rewrite-only pass must
  // NOT search again and must NOT let the scorer re-pick — it only rewrites the
  // TEXT from existing evidence. We carry the prior attempt's pinned cards +
  // owner so the same cards survive the retry (no scorer takeover).
  const rewriteOnlyRetry = ctx?.rewriteOnlyRetry === true;
  const carriedCards =
    rewriteOnlyRetry && Array.isArray(ctx?.carriedCards) && ctx.carriedCards.length > 0
      ? ctx.carriedCards
      : null;
  const carriedCardOwner = carriedCards ? (ctx?.carriedCardOwner || null) : null;

  const planNeedsSearchRaw = planRequiresSearchFlag(ctx?.turnPlan);
  const forcedOk = forcedSearchAllowed({ ctx, text: fullResponseText });
  // Rewrite-only retries never force a plan-driven search.
  const planNeedsSearch = planNeedsSearchRaw && forcedOk && !rewriteOnlyRetry;
  if (planNeedsSearchRaw && !forcedOk) {
    console.log(`[chat] turn-plan(${ctx?.turnPlan?.workflow}): forced search REFUSED — no concrete commerce constraint or clarifying answer (no raw-sentence search)`);
  }
  if (rewriteOnlyRetry && planNeedsSearchRaw) {
    console.log(`[chat] turn-plan(${ctx?.turnPlan?.workflow}): rewrite-only retry — skipping plan-driven forced search (reuse prior evidence)`);
  }
  if (planNeedsSearch && !productSearchAttempted) {
    console.log(`[chat] turn-plan(${ctx.turnPlan.workflow}): searchRequired but model did not search — forcing plan-driven search`);
  }
  // Answer workflows: the forced-card fallback must search the CURRENT turn's
  // family (from the captured evidence query or the latest message), never the
  // stale-memory scope. Otherwise a prior Disney/sneakers turn turns this
  // forced search into query="sneakers" and the cards diverge from the answer.
  const answerWorkflowTurn = isAnswerWorkflow(ctx?.turnPlan);
  const forcedSearchInput = answerWorkflowTurn
    ? buildAnswerWorkflowForcedSearch({ ctx, capturedInput: turnEvidenceSearchInput })
    : scopedProductSearchInput(ctx);
  if (answerWorkflowTurn) {
    console.log(`[chat] turn-plan(${ctx.turnPlan.workflow}): forced-card search locked to current-turn evidence query="${String(forcedSearchInput.input?.query || "").slice(0, 50)}" (no stale memory)`);
  }
  // INVARIANT (pivot_search_scope_leak): on a RESET/PIVOT turn, the FINAL
  // generated search request must not carry a scope constraint the current
  // message never stated. Checked AFTER the query+filters are built (not just
  // after TurnPlan) so a stale category/use-case/family in the actual query is
  // caught — the exact bad case: "Wait, show me shoes instead, not orthotics."
  // → query "women's sneakers walking".
  // Only an EXPLICIT reset/pivot turn ("instead", "actually", "now show me…")
  // can leak stale scope — a plain fresh browse ("do you have wedges in black")
  // states its own constraints, so checking it just produces false positives
  // (the canonical category "wedges-heels" tokenizes to "heels", which the word
  // "wedges" doesn't literally contain). Restrict the invariant to real pivots.
  if (isPivotResetTurn(ctx.latestUserMessage || "")) {
    const leaked = pivotSearchScopeLeak({
      message: ctx.latestUserMessage || "",
      query: forcedSearchInput?.input?.query || "",
      filters: forcedSearchInput?.input?.filters || {},
      knownColors: Array.isArray(ctx.catalogColorList) ? ctx.catalogColorList : [],
    });
    if (leaked.length > 0) {
      recordTurnInvariantViolation("pivot_search_scope_leak", {
        message: String(ctx.latestUserMessage || "").slice(0, 60),
        leaked, query: String(forcedSearchInput?.input?.query || "").slice(0, 60),
      });
    }
  }
  const ensuredCards = await ensureProductTurnCards({
    ctx,
    allProductPool,
    dispatchTool,
    extractProductCards: (n, r) => extractProductCards(n, r, ctx),
    searchInput: forcedSearchInput,
    // Rewrite-only retries never search — reuse the prior attempt's evidence.
    // prior_evidence_availability remaps prior cards deterministically per family
    // (below) — it must never run a broad search that surfaces unrelated products.
    shouldAttach: (productTurnWantsCards || planNeedsSearch) && !rewriteOnlyRetry && ctx?.turnPlan?.workflow !== "prior_evidence_availability",
    allowRelaxedNoMatch: isCompoundPolicyProductQuestion(ctx.latestUserMessage),
    reason: planNeedsSearch && !productTurnWantsCards ? "plan-search-required" : "pre-display",
  });
  if (ensuredCards.searchAttempted) productSearchAttempted = true;
  let pool = ensuredCards.products;
  // Rewrite-only retry: seed the pool (and evidence map) with the prior
  // attempt's cards so the deterministic pin blocks below re-find their
  // family/slot cards instead of coming up empty and ceding to the scorer.
  if (rewriteOnlyRetry && carriedCards) {
    const seen = new Set((pool || []).map((c) => String(c.handle || c.title || "").toLowerCase()));
    for (const c of carriedCards) {
      const key = String(c.handle || c.title || "").toLowerCase();
      if (key && !seen.has(key)) { pool.push(c); seen.add(key); }
      if (key && !allProductPool.has(key)) allProductPool.set(key, c);
    }
    console.log(`[rewrite-only] seeded pool with ${carriedCards.length} prior card(s) owner=${carriedCardOwner || "-"}`);
  }
  // Set by the workflow=availability block when Availability Truth owns the
  // turn: the EXACT, authoritative final card list. When non-null it wins over
  // every downstream card guard/scorer and is emitted verbatim.
  let availabilityPinnedCards = null;
  // Set by the availability-truth block to the verdict's result+reason. A
  // PARTIAL verdict (UNKNOWN with a card shown — width/size not in the variant
  // options, unparsed constraints, no exposed inventory) is a VALID honest
  // answer, NOT a denial — used to exempt it from the denial_with_products
  // warning that otherwise burns retries (live QA 2026-06-30).
  let availabilityVerdictReason = null;
  let availabilityVerdictResult = null;
  // Set by the workflow=comparison block: ONE representative card per named
  // family (max 4). Like availabilityPinnedCards, it wins over the scorer so a
  // two-product comparison never floods the carousel with 9 cards.
  let comparisonPinnedCards = null;
  // Set by the EvidencePlan block (multi_recommendation / compatibility): the
  // exact cards selected by deterministic per-slot search. Wins over the scorer
  // so condition/multi answers keep their current-turn evidence cards.
  let evidencePinnedCards = null;
  // Set by the prior_evidence_availability block: the previously-displayed
  // products remapped to a new color/size/width constraint ("do they come in
  // black?"). Like the other pins it wins over the scorer — the cards are a
  // subset/remap of the prior displayed families, never random alternates.
  let priorEvidencePinnedCards = null;
  // True once a prior_evidence_availability search (per-family or the broaden
  // fallback) actually returned gender-correct products. Used by the turn
  // invariant: search-found + show_availability must not finish with zero cards.
  let priorEvidenceSearchFound = false;
  // Handles the broaden fallback DELIBERATELY surfaced from non-prior families
  // (the prior styles didn't offer the asked width/size/color). These are
  // intentional alternates, so the stray-card invariant must exempt them.
  const priorEvidenceBroadenHandles = new Set();
  // Deterministic concise fallback text built from the pinned evidence cards.
  // When the LLM's phrasing for a multi_recommendation turn can't pass the
  // grounding validator (typically `too_long` after rewrite-only retries), the
  // runner ships THIS instead of dropping the cards to a support handoff — the
  // pinned cards are the real answer and must survive.
  let evidenceFallbackText = null;
  // Ownership instrumentation (see docs/chatbot-ownership-map.md). answerOwner
  // is who produced the customer-facing TEXT; ownedTextSnapshot is that text
  // captured BEFORE the safety-cleanup pipeline runs, so the turn-invariant log
  // can report whether cleanup changed it. Default: the LLM owns the answer.
  let answerOwner = "llm";
  // The final card owner for this turn (availability-truth | comparison |
  // evidence-plan | scorer | none), computed at the turn-invariant log and
  // returned so the retry orchestrator can carry it into a rewrite-only retry.
  let resolvedCardOwner = "none";
  let ownedTextSnapshot = null;

  // Required named-family evidence (#2/#3/#4). For answer workflows where the
  // customer NAMED product families (Jillian, Savannah), those families MUST be
  // in the evidence — even when the model only searched alternatives ("dressy
  // wedding arch support"). Search each missing family and PREPEND its cards so
  // the answer text (which names Jillian) and the displayed cards stay locked
  // to the same families. This is what prevents the alignment validator from
  // suppressing 8→0 when the named product exists in the catalog.
  if (answerWorkflowTurn && Array.isArray(ctx.turnPlan?.namedFamilies) && ctx.turnPlan.namedFamilies.length > 0) {
    const poolFamilies = () => new Set(Array.from(allProductPool.values()).map((c) => titleStyleFamily(c.title || "").toLowerCase()));
    const namedCards = [];
    // STALE-GENDER GUARD. A named family identifies the product on its own (the
    // title-family filter below pins it), so the search must NOT be constrained
    // by a STALE conversation gender — "Do you have Danika in black size 8.5?"
    // after a prior men's turn would search gender=men, miss the women's-only
    // Danika, and force a relaxedFilters.gender retry (live trace 2026-06-30).
    // Apply the gender filter ONLY when THIS message states a gender ("the
    // men's Danika"); otherwise leave it off and let resolvedFamilyGender below
    // adopt the found product's own catalog gender.
    const genderStatedThisTurn = detectLatestGender(String(ctx.latestUserMessage || ""));
    const namedSearchGender = genderStatedThisTurn || null;
    if (ctx.turnPlan.gender && !genderStatedThisTurn) {
      console.log(`[chat] named-family search: dropping stale gender=${ctx.turnPlan.gender} (not stated this turn) so the resolved family gender can drive`);
    }
    for (const fam of ctx.turnPlan.namedFamilies) {
      const have = poolFamilies().has(fam);
      if (!have) {
        try {
          const famInput = { query: fam, filters: namedSearchGender ? { gender: namedSearchGender } : {}, limit: 6 };
          const r = await dispatchTool("search_products", famInput, ctx);
          const famCards = extractProductCards("search_products", r, ctx).filter((c) => titleStyleFamily(c.title || "").toLowerCase() === fam);
          console.log(`[chat] turn-plan(${ctx.turnPlan.workflow}): forced named-family search "${fam}" → ${famCards.length} card(s)`);
          for (const c of famCards) {
            const key = c.handle || c.title;
            if (key && !allProductPool.has(key)) allProductPool.set(key, c);
          }
          if (famCards.length) productSearchAttempted = true;
        } catch (e) {
          console.error(`[chat] named-family search failed for "${fam}":`, e?.message || e);
        }
      }
      for (const c of Array.from(allProductPool.values())) {
        if (titleStyleFamily(c.title || "").toLowerCase() === fam) namedCards.push(c);
      }
    }
    // Prepend named-family cards (named first, alternatives after), deduped.
    if (namedCards.length) {
      const seen = new Set();
      const merged = [];
      for (const c of [...namedCards, ...pool]) {
        const key = String(c.handle || c.title || "").toLowerCase();
        if (key && !seen.has(key)) { seen.add(key); merged.push(c); }
      }
      pool = merged;
    }
    // RESOLVED-GENDER OVERRIDE. A named product's catalog gender is authoritative
    // — once we've FOUND the family, adopt its gender for the rest of the turn so
    // a stale conversation gender (a prior "men's" turn) can't mislabel a women's
    // Savannah/Gabby in the CTA/memory or force a fail-open (live trace
    // 2026-06-30: Savannah carried gender=men). Only when the found cards share a
    // single clear gender — a genuinely mixed family is left to the stated gender.
    const resolved = resolvedFamilyGender(namedCards);
    if (resolved && ctx.sessionGender !== resolved) {
      console.log(`[chat] resolved-gender override: named family gender=${resolved} supersedes stale gender=${ctx.sessionGender || "-"} for this turn`);
      ctx.sessionGender = resolved;
      if (ctx.turnPlan) ctx.turnPlan.gender = resolved;
    }
  }

  // ── Prior-evidence availability ───────────────────────────────────────
  // workflow=prior_evidence_availability: the customer applied a new
  // color/size/width constraint to the SET of products we just showed ("do they
  // come in black?", "what about size 8?"). There's no single named family — the
  // ask targets EACH prior family. We remap every prior family to the new
  // constraint deterministically (Availability Truth per family), show only the
  // matching prior products' cards, and OWN the answer text. Never the scorer.
  if (ctx.turnPlan?.workflow === "prior_evidence_availability") {
    try {
      const latestMsg = ctx.latestUserMessage || "";
      const priorCards = Array.isArray(ctx.priorProductCards) ? ctx.priorProductCards : [];
      // Distinct prior families, in display order, with a representative card.
      const famOrder = [];
      const famPriorCard = new Map();
      for (const c of priorCards) {
        const f = familyOfTitle(c?.title || "");
        if (f && !famPriorCard.has(f)) { famOrder.push(f); famPriorCard.set(f, c); }
      }
      // Load each family's products once; union the colors so the asked color
      // parses regardless of which family carries it.
      const famProductsMap = new Map();
      const unionColors = new Set();
      for (const family of famOrder) {
        const fps = await prisma.product.findMany({
          where: { shop: ctx.shop, NOT: { status: { in: ["DRAFT", "ARCHIVED"] } }, title: { contains: family, mode: "insensitive" } },
          include: { variants: true },
          take: 50,
        });
        famProductsMap.set(family, fps);
        for (const col of collectFamilyColors(fps)) unionColors.add(col);
      }
      const unionColorList = Array.from(unionColors);
      // The NEW constraint the customer asked about THIS turn (color/size/width),
      // plus any size/width inherited from earlier availability turns. A turn can
      // request MULTIPLE colors ("champagne or rose") — check every one per family.
      const asked = parseAvailabilityConstraints(latestMsg, unionColorList);
      const reqColors = parseRequestedColors(latestMsg, unionColorList);
      const priorInherit = priorAvailabilityConstraints(ctx.messages, unionColorList);
      const reqSize = asked.size || priorInherit.size || null;
      const reqWidth = asked.width || priorInherit.width || null;
      const multiColor = reqColors.length >= 2;

      // Resolve one variant card for a family in a specific color (scoped
      // per-family search, never a broad scorer search). Falls back to the prior
      // card. effColor lets a soft-match surface the real variant ("pink"→Rose).
      const findFamilyColorCard = async (family, effColor) => {
        try {
          const filters = {};
          if (effColor) filters.color = effColor;
          const cands = extractProductCards("search_products", await dispatchTool("search_products", { query: family, filters, limit: 4 }, ctx), ctx);
          const sameFam = (cands || []).filter((c) => titleStyleFamily(c.title || "").toLowerCase() === family);
          return (effColor ? sameFam.find((c) => String(c.title || "").toLowerCase().includes(String(effColor).toLowerCase())) : null)
            || sameFam[0] || null;
        } catch (e) { console.warn(`[prior-evidence] remap search failed for "${family}":`, e?.message || e); return null; }
      };

      const pickedCards = [];
      const seenHandles = new Set();
      const pushCard = (card) => {
        if (!card) return;
        const key = String(card.handle || card.title || "").toLowerCase();
        if (key && !seenHandles.has(key)) { pickedCards.push(card); seenHandles.add(key); }
      };

      let items = null;       // single-constraint path: [{ name, ok }]
      let perFamily = null;   // multi-color path: [{ name, available:[], missing:[] }]

      if (multiColor) {
        perFamily = [];
        for (const family of famOrder) {
          const famProducts = famProductsMap.get(family) || [];
          const displayName = styleNameOfTitle(famPriorCard.get(family)?.title || "") || titleCaseWord(family);
          const available = [];
          const missing = [];
          let firstCard = null;
          for (const color of reqColors) {
            const verdict = classifyAvailability({ products: famProducts, family, color, size: reqSize, width: reqWidth });
            if (verdict.result === AVAILABILITY_RESULT.AVAILABLE) {
              available.push(color);
              if (!firstCard) firstCard = await findFamilyColorCard(family, verdict.matchedColor || color);
            } else {
              missing.push(color);
            }
          }
          // Show one card per family that matches ANY requested color.
          if (available.length > 0) pushCard(firstCard || famPriorCard.get(family) || null);
          perFamily.push({ name: displayName, available, missing });
        }
        fullResponseText = buildPriorEvidenceMultiColorText(perFamily);
      } else {
        const reqColor = asked.color || null;
        const askedLabel = askedConstraintLabel({
          reqColor,
          askedSize: asked.size,
          askedWidth: asked.width,
          inheritedSize: priorInherit.size,
          inheritedWidth: priorInherit.width,
        });
        items = [];
        for (const family of famOrder) {
          const famProducts = famProductsMap.get(family) || [];
          const displayName = styleNameOfTitle(famPriorCard.get(family)?.title || "") || titleCaseWord(family);
          const verdict = classifyAvailability({ products: famProducts, family, color: reqColor, size: reqSize, width: reqWidth });
          const ok = verdict.result === AVAILABILITY_RESULT.AVAILABLE;
          if (ok) pushCard((await findFamilyColorCard(family, verdict.matchedColor || reqColor)) || famPriorCard.get(family) || null);
          items.push({ name: displayName, ok });
        }
        fullResponseText = buildPriorEvidenceAvailabilityText(items, askedLabel, Boolean(reqColor));

        // BROADEN FALLBACK. None of the prior styles offers the requested
        // constraint (width / size / color / a feature like waterproof) — don't
        // dead-end with zero-card ambiguity. Search for alternatives that DO
        // offer it WITHIN the established gender, and show up to 3 (live trace
        // 2026-06-30: "What about wide widths?" found 8 women's wide products yet
        // ended with zero cards because the per-family variant re-confirm rejected
        // all of them). Two safety rules: (a) never fail open to the opposite
        // gender — every candidate is gender-guarded; (b) if the strict variant
        // re-confirm rejects everything but the gender-filtered search DID return
        // real products, trust the search (it already applied the constraint) and
        // show those rather than finishing at zero.
        const noPriorMatch = !items.some((it) => it.ok);
        const featureKw = (latestMsg.match(/\b(waterproof|water[-\s]?resistant|slip[-\s]?resistant|leather|suede|memory\s+foam|machine\s+washable|vegan)\b/i) || [])[0] || null;
        if (noPriorMatch && (reqWidth || reqSize || reqColor || featureKw)) {
          try {
            // Establish the gender for the broaden so we never fail open. Prefer
            // the session gender, then stored memory gender, a men/women TurnPlan
            // gender, then the prior displayed cards' gender when they unanimously
            // agree. (Live trace 2026-06-30: none of these were set — the store's
            // women default lived only in the search scope — so the guard ran as a
            // no-op; we now also INFER from the result set below.)
            const priorGenders = Array.from(new Set(
              priorCards.map((c) => normalizeGender(c?._gender || c?.gender)).filter((g) => g === "men" || g === "women" || g === "kids"),
            ));
            let fbGender = ctx.sessionGender
              || normalizeGender(ctx.sessionMemory?.explicit?.gender)
              || normalizeGender(ctx.sessionMemory?.inferred?.gender)
              || (ctx.turnPlan?.gender === "men" || ctx.turnPlan?.gender === "women" ? ctx.turnPlan.gender : null)
              || (priorGenders.length === 1 ? priorGenders[0] : null);
            const cardGenderOk = (c) => {
              if (!fbGender) return true;            // no established gender — don't over-filter
              const g = normalizeGender(c?._gender || c?.gender);
              return !g || g === "unisex" || g === fbGender; // drop ONLY the opposite gender
            };

            const label = reqWidth ? "wide width" : reqSize ? `size ${reqSize}` : reqColor ? String(reqColor) : String(featureKw).toLowerCase();
            const constraintTerm = reqWidth ? "wide width" : reqSize ? `size ${reqSize}` : reqColor || String(featureKw);
            const priorCats = Array.from(new Set(
              priorCards.map((c) => String(c?._category || c?.category || "").toLowerCase()).filter(Boolean),
            ));
            const altFilters = {};
            if (fbGender && fbGender !== "kids") altFilters.gender = fbGender;
            if (priorCats.length === 1) altFilters.category = priorCats[0];
            if (reqColor) altFilters.color = reqColor;
            const altQuery = [constraintTerm, priorCats[0] || "shoes"].filter(Boolean).join(" ");
            const altCandsRaw = extractProductCards("search_products", await dispatchTool("search_products", { query: altQuery, filters: altFilters, limit: 8 }, ctx), ctx);
            // No established gender? INFER it from the result set's majority so the
            // guard still enforces a single gender (the search scopes by the store
            // default, but never trust that — pin it down and drop any minority
            // opposite-gender card rather than ship a mixed-gender carousel).
            if (!fbGender) {
              const tally = {};
              for (const c of (altCandsRaw || [])) {
                const g = normalizeGender(c?._gender || c?.gender);
                if (g === "men" || g === "women" || g === "kids") tally[g] = (tally[g] || 0) + 1;
              }
              const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
              if (top) { fbGender = top[0]; console.log(`[prior-evidence] ${label} broaden: gender inferred from results = ${fbGender}`); }
            }
            // Gender guard — never let an opposite-gender product through.
            const altCands = (altCandsRaw || []).filter(cardGenderOk);
            if (altCands.length > 0) priorEvidenceSearchFound = true;

            // Strict pass: confirm the constraint against variant truth where we
            // can (width/size/color). Feature asks (waterproof) have no variant
            // facts to check, so trust the search keyword match.
            const confirmed = [];
            for (const c of altCands) {
              const key = String(c.handle || c.title || "").toLowerCase();
              if (!key || seenHandles.has(key)) continue;
              if (reqWidth || reqSize || reqColor) {
                const fam = titleStyleFamily(c.title || "").toLowerCase();
                if (!fam) continue;
                const fps = await prisma.product.findMany({
                  where: { shop: ctx.shop, NOT: { status: { in: ["DRAFT", "ARCHIVED"] } }, title: { contains: fam, mode: "insensitive" } },
                  include: { variants: true }, take: 20,
                });
                const v = classifyAvailability({ products: fps, family: fam, size: reqSize, width: reqWidth, color: reqColor || null });
                if (v.result === AVAILABILITY_RESULT.AVAILABLE) { confirmed.push(c); if (confirmed.length >= 3) break; }
              } else {
                confirmed.push(c); if (confirmed.length >= 3) break;
              }
            }

            // SAFE BROADEN: the strict re-confirm rejected everything, but the
            // gender-filtered search returned real products. The search already
            // applied gender + the constraint, so show those instead of zero.
            let shown = confirmed;
            if (shown.length === 0 && altCands.length > 0) {
              shown = altCands
                .filter((c) => { const k = String(c.handle || c.title || "").toLowerCase(); return k && !seenHandles.has(k); })
                .slice(0, 3);
              if (shown.length > 0) console.log(`[prior-evidence] ${label} safe-broaden: variant re-confirm matched 0, showing ${shown.length} gender-guarded search result(s) (gender=${fbGender || "-"})`);
            }

            const fallbackText = buildWidthSizeFallbackText(label, shown.length);
            if (fallbackText && shown.length > 0) {
              for (const c of shown) {
                pushCard(c);
                const k = String(c.handle || c.title || "").toLowerCase();
                if (k) priorEvidenceBroadenHandles.add(k); // intentional alternate — exempt from stray-card invariant
              }
              fullResponseText = fallbackText;
              console.log(`[prior-evidence] ${label} fallback: showing ${shown.length} alternative(s) (gender=${fbGender || "-"})`);
            } else {
              console.log(`[prior-evidence] ${label} fallback: no gender-correct alternatives found (gender=${fbGender || "-"}) — honest no-match text, no cards`);
            }
          } catch (fbErr) {
            console.warn("[prior-evidence] broaden fallback failed (non-fatal):", fbErr?.message || fbErr);
          }
        }
      }
      // Seed the evidence pool with the prior + remapped cards so the grounding
      // validator sees the product names in the deterministic answer as grounded.
      for (const c of [...famOrder.map((f) => famPriorCard.get(f)), ...pickedCards]) {
        if (!c) continue;
        const key = String(c.handle || c.title || "").toLowerCase();
        if (key && !allProductPool.has(key)) allProductPool.set(key, c);
      }
      priorEvidencePinnedCards = pickedCards;
      answerOwner = "prior-evidence";
      console.log(
        `[prior-evidence] families=[${famOrder.join(",")}] colors=[${reqColors.join(",")}]` +
        `${multiColor ? " multi-color" : ""} cards=${pickedCards.length}`,
      );
    } catch (peErr) {
      console.error("[prior-evidence] failed (non-fatal):", peErr?.message || peErr);
    }
  }

  // ── Availability Truth ──────────────────────────────────────────────
  // workflow=availability: answer from product/variant truth, not a generic
  // search. Resolve the named family + color/size/width from the LATEST
  // message (deictic follow-ups inherit the focus product), classify against
  // real variant inventory, then OWN the answer text and restrict the cards to
  // the named family only. Best-effort: any failure leaves the model's reply.
  if (ctx.turnPlan?.workflow === "availability") {
    try {
      const fams = Array.isArray(ctx.turnPlan.namedFamilies) ? ctx.turnPlan.namedFamilies : [];
      const latestMsg = ctx.latestUserMessage || "";
      const isFollowUp = isAvailabilityFollowUp(latestMsg);

      // Resolve the family token. Sources, in priority order — session memory is
      // NEVER consulted (it leaks unrelated prior turns, e.g. a stale "pink"
      // into a Savannah turn):
      //   1. TurnPlan.namedFamilies (the model named a family THIS turn)
      //   2. the PRIOR availability question ("what about size 9?" refers back
      //      to "Savannah champagne size 7 wide", not to an old focus card)
      //   3. the focus product / most-recent displayed card (only as fallback)
      let family = fams[0] || null;
      // Scan PRIOR user turns backward for the most recent one that actually
      // NAMES a family. The single most-recent availability message is often a
      // field-only follow-up ("what about size 8?") that names no product, so
      // relying on it alone loses the family on a later color-only follow-up
      // ("and in black?"). Cap the scan (and DB lookups) to the last few turns.
      if (!family && isFollowUp) {
        const priorUserTexts = (Array.isArray(ctx.messages) ? ctx.messages : [])
          .filter((m) => m?.role === "user")
          .map((m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((b) => b?.type === "text" && b.text).map((b) => b.text).join(" ") : ""))
          .filter(Boolean)
          .slice(0, -1); // exclude the current message
        const scan = priorUserTexts.slice(-6).reverse();
        for (const text of scan) {
          try {
            const priorFams = await extractCatalogProductFamilies(shop, text);
            if (priorFams && priorFams[0]) { family = priorFams[0]; break; }
          } catch { /* best-effort */ }
        }
      }
      if (!family && isFollowUp && ctx.focusProduct) family = familyOfTitle(ctx.focusProduct.title || "");
      // Last resort: the dominant family among the most-recently displayed cards.
      if (!family && isFollowUp && Array.isArray(ctx.priorProductCards) && ctx.priorProductCards.length > 0) {
        const counts = new Map();
        for (const c of ctx.priorProductCards) {
          const f = familyOfTitle(c?.title || "");
          if (f) counts.set(f, (counts.get(f) || 0) + 1);
        }
        family = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      }
      if (!family) {
        console.log(`[availability-truth] no family resolved (named=${fams.length} followUp=${isFollowUp}) — leaving model answer`);
      }

      if (family) {
        // Only trust the focus product when it belongs to the resolved family —
        // a leftover focus card from an unrelated earlier turn (Jillian) must
        // never inject its color/size into a different family's turn (Savannah).
        const consistentFocus =
          ctx.focusProduct && familyOfTitle(ctx.focusProduct.title || "") === family ? ctx.focusProduct : null;
        const famProducts = await prisma.product.findMany({
          where: { shop: ctx.shop, NOT: { status: { in: ["DRAFT", "ARCHIVED"] } }, title: { contains: family, mode: "insensitive" } },
          include: { variants: true },
          take: 50,
        });
        const knownColors = collectFamilyColors(famProducts);
        // Most recent prior availability question — a size-only follow-up
        // ("what about size 9?") inherits its color/width.
        const priorUserMsg = isFollowUp ? priorAvailabilityMessage(ctx.messages, knownColors) : "";
        // Accumulate the most-recent prior size/width/color across ALL prior
        // availability turns so a color-only follow-up keeps an earlier size.
        const priorConstraints = isFollowUp ? priorAvailabilityConstraints(ctx.messages, knownColors) : null;
        const req = resolveAvailabilityRequest({
          message: latestMsg,
          priorMessage: priorUserMsg,
          priorConstraints,
          namedFamilies: family ? [family] : fams,
          focusProduct: consistentFocus,
          isFollowUp,
          knownColors,
        });
        // B. If the customer's text requested a constraint we couldn't parse,
        // never claim AVAILABLE — force UNKNOWN.
        const intent = constraintIntent(latestMsg, knownColors);
        const priorIntent = isFollowUp ? constraintIntent(priorUserMsg, knownColors) : { color: false, size: false, width: false };
        const unverified = [];
        if ((intent.color || (isFollowUp && priorIntent.color)) && !req.color) unverified.push("color");
        if ((intent.size || (isFollowUp && priorIntent.size)) && !req.size) unverified.push("size");
        if ((intent.width || (isFollowUp && priorIntent.width)) && !req.width) unverified.push("width");

        // Diagnostic: distinguishes a parser bug from genuinely-missing data.
        const diag = variantDataDiagnostics(famProducts, family);
        console.log(
          `[availability-truth] variants=${diag.variants} optionShape=${diag.optionShape} ` +
          `sizes=[${diag.sizes.join(",")}] widths=[${diag.widths.join(",")}]`,
        );
        // Style disambiguation inputs: the request text (current + prior on a
        // follow-up) and the prior focus product's style key, so "Jillian" with
        // multiple styles asks which, and a follow-up inherits the focus style.
        const styleQuery = `${latestMsg} ${isFollowUp ? priorUserMsg : ""}`;
        const focusStyleKey = isFollowUp && consistentFocus ? styleKeyOfTitle(consistentFocus.title || "") : null;
        const verdict = classifyAvailability({ products: famProducts, family, color: req.color, size: req.size, width: req.width, unverifiedConstraints: unverified, styleQuery, focusStyleKey });
        console.log(
          `[availability-truth] family=${family} color=${req.color || "-"} size=${req.size || "-"} width=${req.width || "-"} ` +
          `result=${verdict.result} reason=${verdict.reason || "-"}`,
        );
        // Disambiguation diagnostic: which styles the family token covered, and
        // which one we resolved to (or "(ask)" when we hand back a clarifier).
        const styleCandidates = Array.from(new Set(famProducts.map((p) => styleNameOfTitle(p.title || "")).filter(Boolean)));
        if (styleCandidates.length > 1) {
          const selected = verdict.result === AVAILABILITY_RESULT.DISAMBIGUATION
            ? "(ask)" : styleNameOfTitle(verdict.product?.title || "") || "-";
          console.log(
            `[availability-truth] family=${family} styleCandidates=[${styleCandidates.join(",")}] ` +
            `selected=${selected} reason=${verdict.reason || "-"}`,
          );
        }
        fullResponseText = buildAvailabilityAnswer(verdict);
        answerOwner = "availability-truth";
        availabilityVerdictReason = verdict.reason || null;
        availabilityVerdictResult = verdict.result || null;
        if (verdict.result === AVAILABILITY_RESULT.NOT_FOUND) {
          pool = [];
          console.log(`[availability-truth] display=none (not found)`);
        } else if (verdict.result === AVAILABILITY_RESULT.DISAMBIGUATION) {
          // Show one representative card per matching style so the shopper can
          // pick, rather than a single silently-chosen card.
          const wantKeys = Array.from(new Set((verdict.products || []).map((p) => styleKeyOfTitle(p.title || ""))));
          const picked = [];
          const seen = new Set();
          for (const c of pool) {
            const k = styleKeyOfTitle(c.title || "");
            if (wantKeys.includes(k) && !seen.has(k)) { picked.push(c); seen.add(k); }
          }
          if (picked.length > 0) pool = picked;
          else pool = pool.filter((c) => titleStyleFamily(c.title || "").toLowerCase() === family).slice(0, Math.max(2, wantKeys.length));
          console.log(`[availability-truth] display=disambiguation cards=${pool.length}`);
        } else {
          const famCards = pool.filter((c) => titleStyleFamily(c.title || "").toLowerCase() === family);
          if (famCards.length > 0) pool = famCards.slice(0, 1);
          console.log(`[availability-truth] display=family-only cards=${pool.length}`);
        }
        // PIN the Availability Truth card selection as authoritative. From here
        // on these are the final cards — no downstream response-contract,
        // cleanup, group guard, scorer, or LLM buffer flush may drop them. The
        // final card emitter reads availabilityPinnedCards and bypasses scoring.
        availabilityPinnedCards = pool.slice();
        console.log(`[availability-truth] pinnedFinalCards=${availabilityPinnedCards.length}`);
      }
    } catch (avErr) {
      console.error("[availability-truth] failed (non-fatal):", avErr?.message || avErr);
    }
  }

  // workflow=comparison: pin ONE representative card per named family (max 4).
  // The LLM owns the comparison TEXT; we own the CARDS so a two-product
  // comparison shows ~2 cards (Jillian + Savannah), never the 9-10 card pool the
  // scorer would otherwise surface. Bypasses the scorer like availability.
  if (ctx.turnPlan?.workflow === "comparison" && !availabilityPinnedCards && !comparisonPinnedCards) {
    try {
      const fams = Array.isArray(ctx.turnPlan.namedFamilies) ? ctx.turnPlan.namedFamilies : [];
      const findFamilyCard = (fam) => {
        for (const src of [pool, Array.from(allProductPool.values())]) {
          const c = (src || []).find((x) => titleStyleFamily(x.title || "").toLowerCase() === fam);
          if (c) return c;
        }
        return null;
      };
      const picked = [];
      const seenFam = new Set();
      const missing = [];
      for (const fam of fams) {
        if (seenFam.has(fam)) continue;
        const card = findFamilyCard(fam);
        if (card) { picked.push(card); seenFam.add(fam); }
        else missing.push(fam);
      }
      // Deterministic per-family fallback: when an exact family lookup misses,
      // search for THAT family independently and pin its card. Never the scorer.
      // Skipped on a rewrite-only retry (no searching — carried cards stand in).
      if (missing.length > 0 && !rewriteOnlyRetry) {
        for (const fam of missing) {
          if (seenFam.has(fam)) continue;
          try {
            const cards = extractProductCards("search_products", await dispatchTool("search_products", { query: fam, filters: {}, limit: 4 }, ctx), ctx);
            const card = (cards || []).find((c) => titleStyleFamily(c.title || "").toLowerCase() === fam) || (cards || [])[0] || null;
            if (card) {
              picked.push(card); seenFam.add(fam);
              const key = String(card.handle || card.title || "").toLowerCase();
              if (key && !allProductPool.has(key)) allProductPool.set(key, card);
            }
          } catch (e) { console.warn(`[comparison] family fallback search failed for "${fam}":`, e?.message || e); }
        }
      }
      const stillMissing = fams.filter((f) => !seenFam.has(f));
      // A comparison turn NEVER falls back to generic scorer cards. Pin the
      // families we found (one each, max 4); if NONE were found, ship text-only
      // (empty pinned array) so the scorer is suppressed rather than flooding the
      // carousel with unrelated products.
      comparisonPinnedCards = picked.slice(0, 4);
      console.log(
        `[comparison] pinnedFinalCards=${comparisonPinnedCards.length} families=[${fams.join(",")}]` +
        (stillMissing.length ? ` missing=[${stillMissing.join(",")}] (scorer suppressed)` : "") +
        (rewriteOnlyRetry ? " rewrite-only" : ""),
      );
    } catch (cmpErr) {
      console.error("[comparison] pin failed (non-fatal):", cmpErr?.message || cmpErr);
      // Even on error, never let the scorer own a comparison turn.
      if (!comparisonPinnedCards) comparisonPinnedCards = [];
    }
  }

  // ── EvidencePlan: multi_recommendation + compatibility ────────────────
  // A complex ask is decomposed into slots (one per category) and each slot is
  // searched DETERMINISTICALLY; we pin one best card per slot so the carousel
  // shows exactly N cards (never a flood) and the LLM's text answers concisely.
  if (ctx.turnPlan?.workflow === "multi_recommendation" && !availabilityPinnedCards && !comparisonPinnedCards && !rewriteOnlyRetry) {
    try {
      const cplan = extractConstraintPlan({
        message: ctx.latestUserMessage || "",
        catalogCategories: ctx.catalogCategories || [],
        namedFamilies: Array.isArray(ctx.turnPlan.namedFamilies) ? ctx.turnPlan.namedFamilies : [],
      });
      const gender = ctx.turnPlan.gender === "men" || ctx.turnPlan.gender === "women" ? ctx.turnPlan.gender : (cplan.constraints.gender || null);
      const picked = [];
      // Keep the per-slot category alongside each pinned card so the
      // deterministic concise fallback can label "X for sandals, Y for sneakers".
      const pickedPairs = [];
      const seenHandles = new Set();
      // Slot searches are deterministic catalog listing — NEVER route an
      // orthotics slot through the guided recommend_orthotic gate (it demands
      // attributes the customer didn't give and ships zero cards). Suppress the
      // orthotic redirect for these slot searches; the guided finder is reserved
      // for an explicit "help me choose the right orthotic" turn.
      const slotCtx = { ...ctx, suppressOrthoticRedirect: true };
      for (const slot of cplan.slots) {
        const filters = {};
        if (gender && gender !== "kids") filters.gender = gender;
        // Map the umbrella "shoes"/"footwear" to the productType real footwear
        // shares so the slot search constrains to actual footwear instead of
        // surfacing orthotics that the slot guard then rejects (leaving the
        // shoes slot empty). See slotSearchCategory (live trace 2026-06-29).
        if (slot.category) filters.category = slotSearchCategory(slot.category);
        if (slot.constraints?.color) filters.color = slot.constraints.color;
        const input = { query: slot.query, filters, limit: 4 };
        if (slot.constraints?.priceMax) input.priceMax = slot.constraints.priceMax;
        let cards = [];
        try { cards = extractProductCards("search_products", await dispatchTool("search_products", input, slotCtx), ctx); }
        catch (e) { console.warn(`[evidence-plan] slot "${slot.category}" search failed: ${e?.message || e}`); }
        // HARD SLOT GUARD: the picked card must match the slot category. A "shoes"
        // slot can never pin an orthotic/insole; an "orthotics" slot only an
        // orthotic. Off-category hits are skipped so text and cards stay aligned.
        let best = (cards || []).find(
          (c) => c?.handle && !seenHandles.has(c.handle) && cardMatchesSlotCategory(c, slot.category),
        );
        // Per-slot broad fallback: a condition-heavy query ("supportive foot
        // pain shoes") can still rank only off-category items and leave the slot
        // EMPTY — then a turn that promises N categories shows N-1 cards
        // (text/card mismatch, live trace 2026-06-29). Retry once with a broad
        // category-only query so each slot fills whenever the catalog carries
        // anything in that category.
        if (!best && slot.category) {
          const broadInput = { query: slotSearchCategory(slot.category), filters, limit: 6 };
          let broadCards = [];
          try { broadCards = extractProductCards("search_products", await dispatchTool("search_products", broadInput, slotCtx), ctx); }
          catch (e) { /* best-effort */ }
          best = (broadCards || []).find(
            (c) => c?.handle && !seenHandles.has(c.handle) && cardMatchesSlotCategory(c, slot.category),
          );
          if (best) {
            cards = broadCards;
            console.log(`[evidence-plan] slot=${slot.category} broad-fallback filled with ${best.handle}`);
          }
        }
        if (best) {
          picked.push(best); pickedPairs.push({ card: best, category: slot.category }); seenHandles.add(best.handle);
          // Seed the pinned slot card into the evidence pool (mirrors the
          // comparison/prior-evidence blocks). Without this the grounding
          // validator flags the LLM naming a pinned card as ungrounded and burns
          // the whole retry budget on a card we deliberately chose (audit #4).
          const poolKey = String(best.handle || best.title || "").toLowerCase();
          if (poolKey && !allProductPool.has(poolKey)) allProductPool.set(poolKey, best);
        }
        const rejected = (cards || []).length - (cards || []).filter((c) => cardMatchesSlotCategory(c, slot.category)).length;
        console.log(`[evidence-plan] slot=${slot.category} query="${slot.query}" → ${cards?.length || 0} hit(s), ${rejected} off-category skipped, picked=${best ? best.handle : "-"}`);
      }
      if (picked.length > 0) {
        evidencePinnedCards = picked;
        evidenceFallbackText = buildMultiRecoFallbackText(pickedPairs);
        console.log(`[evidence-plan] multi_recommendation pinnedFinalCards=${picked.length} slots=${cplan.slots.length} fallback="${evidenceFallbackText}"`);
      } else {
        console.log(`[evidence-plan] multi_recommendation: no slot cards found — leaving scorer cards`);
      }
    } catch (mrErr) {
      console.error("[evidence-plan] multi_recommendation failed (non-fatal):", mrErr?.message || mrErr);
    }
  }

  // Compatibility: pin ONLY the named product's card (if shown at all). Never
  // surface random orthotic products — the answer is text from product +
  // orthotic knowledge.
  // PRODUCT-TRUTH GUARD (workflow-agnostic). "Can I wear orthotics inside
  // sandals, or do I need closed shoes?" routes to compatibility; "do any
  // sandals have removable footbeds for orthotics?" routes to clarification —
  // but Aetrex product truth doesn't depend on the workflow label. Whenever an
  // orthotic↔sandal compatibility question is asked and the pool has NO explicit
  // orthotic-compatible/removable-footbed evidence, OWN the wording: orthotics go
  // in CLOSED shoes / footwear with removable insoles, never open sandals; for a
  // sandal, point to built-in arch support. If the pool DOES carry explicit
  // evidence for a specific product, defer to the LLM (it may speak to that
  // product). Skip when a stronger deterministic owner already pinned cards.
  if (
    isOrthoticSandalCompatibilityQuestion(ctx.latestUserMessage || "") &&
    !availabilityPinnedCards && !comparisonPinnedCards && !evidencePinnedCards && !priorEvidencePinnedCards &&
    !rewriteOnlyRetry
  ) {
    const compatPool = [...(Array.isArray(pool) ? pool : []), ...Array.from(allProductPool.values())];
    if (!hasExplicitOrthoticCompatibleEvidence(compatPool)) {
      fullResponseText = buildOrthoticCompatibilityAnswer();
      answerOwner = "compatibility-truth";
      evidencePinnedCards = [];
      console.log(`[compatibility-truth] orthotic↔sandal question (workflow=${ctx.turnPlan?.workflow || "-"}) — deterministic Aetrex-safe answer, cards=0`);
    }
  }

  if (ctx.turnPlan?.workflow === "compatibility" && answerOwner !== "compatibility-truth" && !availabilityPinnedCards && !comparisonPinnedCards && !evidencePinnedCards && !rewriteOnlyRetry) {
    try {
      const fams = Array.isArray(ctx.turnPlan.namedFamilies) ? ctx.turnPlan.namedFamilies : [];
      if (fams.length > 0) {
        const candidates = [pool, Array.from(allProductPool.values())];
        let card = null;
        for (const src of candidates) {
          card = (src || []).find((c) => titleStyleFamily(c.title || "").toLowerCase() === fams[0]);
          if (card) break;
        }
        evidencePinnedCards = card ? [card] : [];
        // Keep a concise deterministic fallback so a too_long exhaustion ships a
        // short line and KEEPS the named card rather than handing off + dropping it.
        if (card) evidenceFallbackText = `The ${cardDisplayName(card)} is a solid match here — take a look.`;
        console.log(`[evidence-plan] compatibility family=${fams[0]} pinnedFinalCards=${evidencePinnedCards.length}`);
      } else {
        // No named product → text-only compatibility answer, no random cards.
        evidencePinnedCards = [];
        console.log(`[evidence-plan] compatibility: no named product — text-only, cards=0`);
      }
    } catch (compatErr) {
      console.error("[evidence-plan] compatibility failed (non-fatal):", compatErr?.message || compatErr);
    }
  }

  // Named-product advisory: the named product IS the card. Pin it from this
  // turn's evidence (the forced named-family search), the focus product, or
  // prior cards — so the scorer never takes over a pinned workflow (violation
  // pinned_workflow_scorer_takeover, live trace 2026-06-30: Gabby rendered but
  // cardOwner=scorer). Advisory answers about ONE product, so pin singular.
  if (
    ctx.turnPlan?.workflow === "named_product_advisory" &&
    !availabilityPinnedCards && !comparisonPinnedCards && !evidencePinnedCards && !priorEvidencePinnedCards &&
    !rewriteOnlyRetry
  ) {
    try {
      const fams = Array.isArray(ctx.turnPlan.namedFamilies) ? ctx.turnPlan.namedFamilies : [];
      const fam = fams[0] || (ctx.focusProduct ? titleStyleFamily(ctx.focusProduct.title || "").toLowerCase() : null);
      if (fam) {
        const sources = [
          pool,
          Array.from(allProductPool.values()),
          Array.isArray(ctx.priorProductCards) ? ctx.priorProductCards : [],
          ctx.focusProduct ? [ctx.focusProduct] : [],
        ];
        let card = null;
        for (const src of sources) {
          card = (src || []).find((c) => titleStyleFamily(c.title || "").toLowerCase() === fam);
          if (card) break;
        }
        if (card) {
          evidencePinnedCards = [card];
          evidenceFallbackText = `The ${cardDisplayName(card)} is a great pick here — take a look.`;
          console.log(`[evidence-plan] named_product_advisory family=${fam} pinnedFinalCards=1 (owner=evidence-plan)`);
        } else {
          console.log(`[evidence-plan] named_product_advisory family=${fam} — named card not in evidence; text-only`);
        }
      }
    } catch (advErr) {
      console.error("[evidence-plan] named_product_advisory pin failed (non-fatal):", advErr?.message || advErr);
    }
  }

  // ── product_focus / cart_handoff: pin the focused card as a DETERMINISTIC
  // owner and SEED it into the evidence pool. Without this the focus card is a
  // prior card (not in this turn's search evidence), so cardOwner=scorer and the
  // card_not_in_evidence_pool invariant drops it → finalCards=0 after retries
  // (live trace 2026-06-30: "Molly Lace-Up Sneaker" dropped). Owner=evidence-plan
  // exempts it from the scorer membership check; seeding it makes membership true
  // regardless. A stale gender filter can never exclude an explicitly-picked card.
  if (
    (ctx.turnPlan?.workflow === "product_focus" || ctx.turnPlan?.workflow === "cart_handoff") &&
    ctx.focusProduct &&
    !availabilityPinnedCards && !comparisonPinnedCards && !evidencePinnedCards && !priorEvidencePinnedCards &&
    !rewriteOnlyRetry
  ) {
    evidencePinnedCards = [ctx.focusProduct];
    const key = String(ctx.focusProduct.handle || ctx.focusProduct.title || "").toLowerCase();
    if (key && !allProductPool.has(key)) allProductPool.set(key, ctx.focusProduct);
    evidenceFallbackText = `Great pick — the ${cardDisplayName(ctx.focusProduct)}. Want me to check sizes/colors or compare it with a similar style?`;
    console.log(`[evidence-plan] ${ctx.turnPlan.workflow} pinnedFinalCards=1 focused="${ctx.focusProduct.title}" (owner=evidence-plan, seeded pool)`);
  }

  // ── display_recovery: re-pin the PRIOR turn's cards (the customer said they
  // didn't render). Deterministic owner + seed the pool so the membership
  // invariant doesn't drop them.
  if (
    ctx.turnPlan?.workflow === "display_recovery" &&
    Array.isArray(ctx.priorProductCards) && ctx.priorProductCards.length > 0 &&
    !availabilityPinnedCards && !comparisonPinnedCards && !evidencePinnedCards && !priorEvidencePinnedCards &&
    !rewriteOnlyRetry
  ) {
    evidencePinnedCards = ctx.priorProductCards.slice(0, Math.max(1, ctx.productCardCap || 6));
    for (const c of evidencePinnedCards) {
      const key = String(c.handle || c.title || "").toLowerCase();
      if (key && !allProductPool.has(key)) allProductPool.set(key, c);
    }
    console.log(`[evidence-plan] display_recovery re-pinned ${evidencePinnedCards.length} prior card(s) (owner=evidence-plan, seeded pool)`);
  }

  // ── BROAD GENDER BROWSE (runtime override) ──────────────────────────────
  // "Show me men's options" / "what do you have for men" widens to the WHOLE
  // gender line. The unit-level turn-intent drop wasn't enough at runtime: the
  // model still re-searched the PRIOR cards' categories for the new gender
  // (gender=men category="wedges heels"/boots → women-only → gender×category
  // mismatch → final cards=0, "we don't carry men's footwear"; live trace
  // 2026-06-30). Fix deterministically: run a GENDER-ONLY search (no stale
  // category/color/width/condition) and PIN it, so the model's stale-category
  // searches can never become the final cards. Category is honored ONLY if the
  // customer names one in THIS message — and a specific category never matches
  // isBroadGenderRequest, so this fires only on a genuinely broad ask.
  const broadGenderMsg = ctx.latestUserMessage || "";
  const broadGenderDetected = isBroadGenderReset(broadGenderMsg);
  const broadGenderBlocked =
    !!availabilityPinnedCards || !!comparisonPinnedCards || !!evidencePinnedCards ||
    !!priorEvidencePinnedCards || rewriteOnlyRetry;
  if (ctx.turnPlan?.workflow === "browse" && broadGenderDetected && broadGenderBlocked) {
    // Detected but another deterministic owner already pinned cards (or this is a
    // rewrite-only retry). Log so PRD shows the pin was reached and why it ceded.
    console.log(`[broad-gender-browse] detected but ceded — availPin=${!!availabilityPinnedCards} cmpPin=${!!comparisonPinnedCards} evPin=${!!evidencePinnedCards} priorPin=${!!priorEvidencePinnedCards} rewriteOnly=${rewriteOnlyRetry}`);
  } else if (ctx.turnPlan?.workflow === "browse" && !broadGenderDetected) {
    // Browse turn that did NOT look like a broad gender ask — make the negative
    // decision visible so a missed-match (e.g. punctuation) is debuggable in PRD.
    console.log(`[broad-gender-browse] not a broad gender request — msg="${String(broadGenderMsg).slice(0, 60)}"`);
  }
  if (
    ctx.turnPlan?.workflow === "browse" &&
    broadGenderDetected &&
    !broadGenderBlocked
  ) {
    try {
      const bg = broadGenderRequestGender(ctx.latestUserMessage || "") || broadGenderFollowUpGender(ctx.latestUserMessage || "") || ctx.turnPlan?.gender || ctx.sessionGender || null;
      const genderWord = bg === "men" ? "men's" : bg === "women" ? "women's" : bg === "kids" ? "kids" : "";
      const filters = bg ? { gender: bg } : {};
      const cap = Math.max(3, ctx.productCardCap || 6);
      const input = { query: `${genderWord} footwear`.trim() || "footwear", filters, limit: cap };
      const cards = extractProductCards("search_products", await dispatchTool("search_products", input, ctx), ctx);
      const picked = (cards || []).slice(0, cap);
      if (picked.length > 0) {
        evidencePinnedCards = picked;
        for (const c of picked) { const k = String(c.handle || c.title || "").toLowerCase(); if (k && !allProductPool.has(k)) allProductPool.set(k, c); }
        productSearchAttempted = true;
        evidenceFallbackText = `Here are some ${genderWord || ""} options to get you started.`.replace(/\s+/g, " ").trim();
        // The model drafted its text BEFORE this turn against the stale context —
        // if it denied ("we don't carry men's…") or didn't present products,
        // replace it with the clean framing so text and the pinned cards agree.
        // It may ALSO present products but drag the stale scope into the wording
        // ("here are men's shoes for your heel pain and wide feet") — the broad
        // ask cleared that scope, so any stale term NOT in the current message is
        // a leak. Scrub it: replace the whole draft with the clean framing.
        const curMsg = String(ctx.latestUserMessage || "").toLowerCase();
        const STALE_LEAK_RE = /\b(?:heel\s+pain|plantar|flat\s+feet|fasciitis|wide(?:\s+width|\s+feet)?|narrow|wedges?|heels?|boots?|sandals?|sneakers?|loafers?|men'?s?|women'?s?|footwear|comfort|arch\s+support|walking|standing|running|hiking)\b/i;
        const leaks = (fullResponseText.match(new RegExp(STALE_LEAK_RE.source, "gi")) || [])
          .filter((m) => !curMsg.includes(m.toLowerCase()));
        if (detectAiNoMatchPhrasing(fullResponseText) || !textPresentsProducts(fullResponseText) || leaks.length > 0) {
          if (leaks.length > 0) console.log(`[broad-gender-browse] scrubbed stale-scope leak from text: ${JSON.stringify([...new Set(leaks.map((s) => s.toLowerCase()))])}`);
          fullResponseText = evidenceFallbackText;
        }
        console.log(`[broad-gender-browse] gender=${bg || "-"} pinned ${picked.length} card(s) via gender-only search "${input.query}" (overrode stale-category model searches)`);
      } else {
        console.log(`[broad-gender-browse] gender=${bg || "-"} gender-only search returned 0 — leaving to scorer`);
      }
    } catch (bgErr) {
      console.warn("[broad-gender-browse] failed (non-fatal):", bgErr?.message || bgErr);
    }
  }

  // ── ORTHOTIC-FLOW CARD PURITY (pre-emission) ──────────────────────────────
  // The orthotic recommender (recommend_orthotic) only ever returns orthotics/
  // insoles. When it drove the turn and we are NOT cancelling into a fresh
  // footwear request, every candidate card must be an orthotic product BEFORE
  // anything is pinned or streamed. This runs ahead of the condition_recommend
  // pin + the scorer + every product SSE, so:
  //   (a) a CONTINUING orthotic turn whose recommender asked for more info (no
  //       orthotic cards yet) but whose pool was filled by a footwear search
  //       drops to 0 cards — the missing-attribute question stands, no sneakers;
  //   (b) a non-orthotic card can never be emitted on an orthotic-owned turn
  //       (invariant: orthotic_flow_non_orthotic_cards), repaired here not after.
  // A CANCEL turn ("…what would you pick first?") is exempt — it is a footwear
  // request and its footwear cards are the correct answer.
  if (
    recommenderInvokedThisTurn &&
    ctx.orthoticFlowDecision !== "cancel" &&
    !messageExplicitlyAsksForShoes(ctx?.latestUserMessage || "")
  ) {
    const keepOrthotic = (arr) => (Array.isArray(arr) ? arr.filter(isOrthoticProductCard) : arr);
    const poolBefore = Array.isArray(pool) ? pool.length : 0;
    pool = keepOrthotic(pool);
    if (Array.isArray(evidencePinnedCards)) evidencePinnedCards = keepOrthotic(evidencePinnedCards);
    const dropped = poolBefore - (Array.isArray(pool) ? pool.length : 0);
    if (dropped > 0) {
      recordTurnInvariantViolation("orthotic_flow_non_orthotic_cards", { dropped, repaired: "filtered-pre-emission" });
      console.log(`[chat] ${ctx.shop} orthotic-flow card purity: filtered ${dropped} non-orthotic card(s) from the pool before any pin/emit`);
    }
  }

  // ── Condition / advisory recommendation: deterministic 2-3 card selection ──
  // A condition_recommendation turn ("comfortable shoes for standing all day",
  // "plantar fasciitis walking", "cute but supportive for a wedding") must NOT
  // hand 6 scorer-ranked cards to the carousel. Pick 2-3 distinct-family cards
  // from THIS turn's evidence pool — preferring the ones the LLM actually named
  // in its text — and pin them (cardOwner=evidence-plan), so text and cards stay
  // aligned and the scorer never takes over. Skipped on a rewrite-only retry.
  if (
    ctx.turnPlan?.workflow === "condition_recommendation" &&
    !availabilityPinnedCards && !comparisonPinnedCards && !evidencePinnedCards && !priorEvidencePinnedCards &&
    !rewriteOnlyRetry
  ) {
    try {
      const candidates = Array.isArray(pool) ? pool : [];
      if (candidates.length > 0) {
        // Prefer LLM-named cards; backfill to up to 3 distinct families.
        const picked = selectEvidenceCards(candidates, fullResponseText, {
          cap: 3,
          familyOf: (t) => titleStyleFamily(t || "").toLowerCase(),
        });
        if (picked.length > 0) {
          evidencePinnedCards = picked;
          // Deterministic fallback so a validator exhaustion keeps these cards
          // instead of handing off (mirrors multi_recommendation).
          evidenceFallbackText = buildMultiRecoFallbackText(picked.map((c) => ({ card: c, category: null })));
          console.log(`[evidence-plan] condition_recommendation pinnedFinalCards=${picked.length} (pool=${candidates.length})`);
        }
      }
    } catch (crErr) {
      console.error("[evidence-plan] condition_recommendation failed (non-fatal):", crErr?.message || crErr);
    }
  }

  // REWRITE-ONLY RETRY restoration net. If the prior attempt owned its cards but
  // this tools-off rewrite couldn't re-derive them (nothing searched), restore
  // the carried cards + owner directly. This is the last guard that stops the
  // scorer from taking over a comparison / evidence-plan / availability turn on a
  // text-only retry.
  if (rewriteOnlyRetry && carriedCards && !availabilityPinnedCards && !comparisonPinnedCards && !evidencePinnedCards && !priorEvidencePinnedCards) {
    if (carriedCardOwner === "comparison") comparisonPinnedCards = carriedCards.slice(0, 4);
    else if (carriedCardOwner === "evidence-plan") {
      evidencePinnedCards = carriedCards.slice();
      // Restore the deterministic fallback so a rewrite-only evidence-plan retry
      // that still can't pass the validator ships the fallback + keeps cards.
      if (!evidenceFallbackText && ctx?.carriedEvidenceFallbackText) evidenceFallbackText = ctx.carriedEvidenceFallbackText;
    }
    else if (carriedCardOwner === "availability-truth") availabilityPinnedCards = carriedCards.slice();
    else if (carriedCardOwner === "prior-evidence") priorEvidencePinnedCards = carriedCards.slice();
    if (comparisonPinnedCards || evidencePinnedCards || availabilityPinnedCards || priorEvidencePinnedCards) {
      console.log(`[rewrite-only] restored ${carriedCards.length} pinned card(s) owner=${carriedCardOwner} from prior attempt — scorer suppressed`);
    }
  }

  if (ensuredCards.diagnostics?.exactNoMatch && pool.length === 0) {
    const exactNoMatch = buildCodeOwnedExactNoMatchText({ ctx });
    if (exactNoMatch.text) {
      const before = fullResponseText;
      fullResponseText = exactNoMatch.text;
      console.log(
        `[chat] response-contract: code-owned exact no-match ` +
          `(${String(before || "").length}→${fullResponseText.length} chars, reason=${exactNoMatch.reason})`,
      );
    }
  }
  // Non-shoppable guard: drop $0 service line items / fees (e.g. "VIP
  // Processing") that semantic search can surface as fake product cards.
  // Runs on every turn — these are never something a shopper browses.
  {
    const shoppable = dropNonShoppableItems(pool);
    if (shoppable.dropped.length > 0) {
      console.log(`[chat] ${ctx.shop} dropped non-shoppable item(s) from pool:`, shoppable.dropped);
      pool = shoppable.cards;
    }
  }
  // wrong-topic guard: for a general footwear/gift request, drop
  // shoe-care/accessories/socks/gift-cards that semantic search may
  // have surfaced above real shoes. No-op when the customer asked for
  // accessories or when dropping would empty the pool.
  {
    const footwearOnly = dropNonFootwearWhenFootwearIntent(pool, ctx.latestUserMessage);
    if (footwearOnly.dropped.length > 0) {
      console.log(`[chat] ${ctx.shop} wrong-topic guard: dropped non-footwear from pool:`, footwearOnly.dropped);
      pool = footwearOnly.cards;
    }
  }
  // Negative-category backstop: drop cards in a category the customer rejected
  // this turn ("shoes that don't look like sneakers"). Central enforcement for
  // forced-card / evidence-reuse / prior-card paths that bypass the search tool.
  {
    const rejFiltered = dropRejectedCategoryCards(pool, ctx.latestUserMessage);
    if (rejFiltered.dropped.length > 0) {
      console.log(`[chat] ${ctx.shop} rejected-category guard: dropped`, rejFiltered.dropped);
      pool = rejFiltered.cards;
    }
  }
  // Compare-intent flows read the single shared signal off session
  // memory's latestTurnIntent rather than re-running a regex here.
  const isCompareTurn = ctx?.sessionMemory?.latestTurnIntent?.reason === "compare_request";
  const latestComparisonUsesPriorCards =
    isCompareTurn &&
    /\b(?:first\s+two|1st\s+two|these|those|them|ones|both)\b/i.test(String(ctx.latestUserMessage || ""));
  if (
    latestComparisonUsesPriorCards &&
    Array.isArray(ctx.priorProductCards) &&
    ctx.priorProductCards.length >= 2
  ) {
    pool = ctx.priorProductCards.slice(0, Math.max(2, ctx.productCardCap || 3));
    allProductPool.clear();
    for (const card of pool) {
      const key = card?.handle || card?.title;
      if (key) allProductPool.set(key, card);
    }
    console.log(`[chat] comparison handoff: using ${pool.length} prior displayed card(s)`);
  }

  // Snapshot the owner's text BEFORE the safety-cleanup pipeline (finalize /
  // clarifier repair / chip-strip) so the turn-invariant log can report whether
  // cleanup changed it. Cleanup owns final safety only — never product choice.
  ownedTextSnapshot = fullResponseText;

  let genericCTA = null;
  {
    const finalized = finalizeOutboundReply({
      text: fullResponseText,
      pool,
      ctx,
      toolsCalledThisTurn,
      supportCTA,
      recommenderAskedForMoreInfo,
      productSearchAttempted,
      qualitySignals,
    });
    fullResponseText = finalized.text;
    pool = finalized.pool;
    genericCTA = finalized.genericCTA;
  }

  // TurnPlan clarification authority. When the plan says act-don't-ask
  // (clarificationAllowed=false), a generic clarifier reply ("men's or
  // women's?", "tell me more", "what style/color/budget?") violates the
  // contract — the turn should have searched and shown products. Repair it
  // in place: if products are available, swap the stall for a short
  // plan-aware framing and let the cards carry the turn. (Mutating here,
  // before the deferred text emit, so the LLM-owns runner ships the repair.)
  {
    const clarGate = clarifierGateDecision(ctx?.turnPlan, fullResponseText, pool.length > 0);
    if (clarGate.action === "repair" && isAnswerWorkflow(ctx?.turnPlan)) {
      // Answer workflow: do NOT swap in canned "here are some options" copy.
      // Leave the stall so the grounding validator blocks it and the model
      // synthesizes a real answer from evidence (with the honest exhaustion
      // line as the floor). Per the contract, never ship a generic framing
      // for availability/comparison/advisory/condition.
      console.log(`[chat] turn-plan(${ctx.turnPlan.workflow}): disallowed clarifier on answer workflow — leaving for synthesis retry`);
    } else if (clarGate.action === "repair") {
      // Browse / non-answer workflow: a short product framing is acceptable.
      const repaired = buildPlanClarifierRepair(ctx.turnPlan);
      console.log(`[chat] turn-plan(${ctx.turnPlan.workflow}): repaired disallowed clarifier ("${fullResponseText.slice(0, 60).replace(/\s+/g, " ")}…") → product framing`);
      fullResponseText = repaired;
    } else if (clarGate.action === "block_no_products") {
      console.log(`[chat] turn-plan(${ctx.turnPlan.workflow}): disallowed clarifier but no products to repair with — leaving text`);
    }
  }
  // Clarifier-question strip (clarificationAllowed=false). The gate above only
  // repairs a reply that is WHOLLY a short clarifier; a longer recommendation
  // that buries a category/gender/recipient clarifier question at the end slips
  // through. Strip just those question sentences so an act-don't-ask turn never
  // ships "Are you thinking sneakers, sandals, or both? Shopping for yourself?".
  if (ctx?.turnPlan?.clarificationAllowed === false) {
    const clar = stripDisallowedClarifierQuestions(fullResponseText);
    if (clar.stripped.length > 0) {
      console.log(
        `[chat] turn-plan(${ctx.turnPlan.workflow}): stripped disallowed clarifier question(s): ` +
          clar.stripped.map((s) => `"${s.slice(0, 50)}"`).join(", "),
      );
      fullResponseText = clar.text;
    }
  }


  // Clarification card-wipe guard (Failure A). If the assistant's answer is a
  // clarification asking for product/category/size info, it must ship with NO
  // product cards and NO CTAs — UNLESS the plan explicitly pinned a product
  // (availability pinned cards, or a focused product-display policy). This stops
  // a "tell me which product and your usual size" reply from carrying a random
  // browse card + "View All Women's Boots".
  {
    const planPinnedProduct = availabilityPinnedCards != null || planForcesProductDisplay(ctx?.turnPlan);
    const wf = ctx?.turnPlan?.workflow;
    const suppressByPlan = ctx?.turnPlan?.productDisplayPolicy === "suppress" || wf === "clarification" || wf === "sizing_help";
    const clarifyingAnswer = looksLikeClarifyingQuestion(fullResponseText);
    // Real product EVIDENCE must NEVER be wiped: a search ran, the plan required
    // a search, or the assistant text actually presents products ("here are…",
    // "I found…"). The wipe is only for a TRUE clarification-only turn that
    // accidentally carried a stray browse card (live trace 2026-06-29: "how
    // about mens?" misrouted to clarification, then 5 real men's cards were
    // dropped under a "Here are…" answer). The misclassification is fixed in
    // turn-plan; this guard is the safety net so valid cards are never deleted.
    const hasProductEvidence =
      productSearchAttempted === true ||
      ctx?.turnPlan?.searchRequired === true ||
      textPresentsProducts(fullResponseText);
    if (!planPinnedProduct && !hasProductEvidence && (suppressByPlan || clarifyingAnswer) && pool.length > 0) {
      console.log(`[chat] clarification card-wipe: workflow=${wf} clarifyingAnswer=${clarifyingAnswer} — dropping ${pool.length} card(s) + CTAs (no pinned product, no evidence)`);
      pool = [];
      supportCTA = null;
      genericCTA = null;
    } else if (!planPinnedProduct && (suppressByPlan || clarifyingAnswer) && pool.length > 0) {
      console.log(`[chat] clarification card-wipe SKIPPED: workflow=${wf} — ${pool.length} card(s) are real evidence (searchAttempted=${productSearchAttempted}, searchRequired=${ctx?.turnPlan?.searchRequired === true}, presentsProducts=${textPresentsProducts(fullResponseText)})`);
    }
  }

  // ── Card suppression for knowledge / support / sizing turns ───────────────
  // policy_knowledge / account_private_handoff / sizing_help (+ legacy
  // policy_account / customer_service) answer from knowledge or hand off — they
  // NEVER show product cards. Drop any stale prior-turn card that slipped in.
  if (workflowSuppressesCards(ctx.turnPlan?.workflow) && (Array.isArray(pool) ? pool.length : 0) > 0) {
    console.log(`[support-suppress] ${ctx.turnPlan?.workflow}: dropping ${pool.length} card(s) — knowledge/support turn shows no products`);
    pool = [];
    availabilityPinnedCards = null;
    comparisonPinnedCards = null;
    evidencePinnedCards = null;
    priorEvidencePinnedCards = null;
    genericCTA = null;
    supportCTA = null;
  }

  // ── ANSWER-SOURCE CONTRACT (the explicit product-truth / RAG / handoff fix) ─
  // KNOWLEDGE workflow (policy_knowledge): answer from the model's RAG/knowledge
  // reply (UI-meta stripped); hand off ONLY when it couldn't answer (requirement
  // #5: A. try RAG → B. answer from it → C. else friendly handoff). PRIVATE
  // workflow (account_private_handoff / customer_service): deterministic support
  // handoff + live-chat CTA (Zendesk/Intercom/Gorgias, Support Hub URL fallback).
  // Either way: no product cards, no product quick replies, no UI-meta text. This
  // replaces the prior contract that force-handed-off every verification/account-
  // shaped message and discarded the RAG-grounded answer (the root bug here).
  {
    const wf = ctx.turnPlan?.workflow;
    const contract = applyAnswerSourceContract({
      workflow: wf,
      msg: ctx.latestUserMessage || "",
      text: fullResponseText,
      ctx,
      retrievedChunks: ctx.retrievedChunks,
      knowledgeText: ctx.knowledgeText || "",
    });
    if (contract.applies) {
      // No product cards / product CTAs on any knowledge or handoff turn.
      pool = [];
      availabilityPinnedCards = null;
      comparisonPinnedCards = null;
      evidencePinnedCards = null;
      priorEvidencePinnedCards = null;
      genericCTA = null;
      supportCTA = null;
      fullResponseText = contract.text;
      if (contract.handoff) {
        evidenceFallbackText = null;
        supportHandoffCta = contract.supportCta;
        qualitySignals.supportHandoffApplied = true;
      } else {
        // Knowledge answer kept verbatim (meta stripped) — no forced support CTA.
        supportHandoffCta = null;
      }
      // INVARIANTS (requirement #6).
      if (contract.metaLeak) {
        recordTurnInvariantViolation("support_meta_text_leak", { workflow: wf });
      }
      if (contract.isKnowledge && contract.source === "support_handoff") {
        if (contract.ragHit) {
          // RAG found relevant snippets but the answer still handed off.
          recordTurnInvariantViolation("policy_rag_hit_handoff", { workflow: wf });
        } else if (!contract.ragAttempted && ctx.knowledgeRagEnabled) {
          // A knowledge query went to support without RAG being attempted.
          recordTurnInvariantViolation("policy_rag_skipped", { workflow: wf });
        }
        if (contract.prematureHandoff) {
          // RAG missed but the knowledge corpus DOES contain the query terms —
          // we punted to support without exhausting lexical fallback.
          recordTurnInvariantViolation("policy_handoff_without_lexical_fallback", { workflow: wf });
        }
      }
      console.log(
        `[answer-source] source=${contract.source}` +
        `${contract.handoffReason ? ` reason=${contract.handoffReason}` : ""} ` +
        `workflow=${wf} ragAttempted=${contract.ragAttempted} ragHit=${contract.ragHit} ` +
        `lexicalHit=${contract.lexicalHit} metaLeak=${contract.metaLeak} cta=${Boolean(supportHandoffCta)}`,
      );
    }
  }

  // ── Support-handoff safety gate ───────────────────────────────────────
  // FINAL gate (not a random text scrubber): when the bot genuinely can't
  // finish — explicit human request, dead-end "I can't verify" with no cards,
  // or a partial answer that needs human confirmation — hand off to Aetrex
  // customer service instead of dead-ending. Validator-exhausted (ok=false) is
  // handled in the LLM-owns runner where the validation result is known. NEVER
  // fires on a successful product/sale/comparison turn or a normal clarification
  // (the detector excludes those).
  // Knowledge + private-handoff workflows are already owned by the answer-source
  // contract above — skip this generic gate so it can't wipe a kept RAG answer
  // (e.g. a knowledge reply that mentions "contact support" matching DEAD_END_RE).
  if (
    !isKnowledgeWorkflow(ctx.turnPlan?.workflow) &&
    !isPrivateHandoffWorkflow(ctx.turnPlan?.workflow) &&
    ctx.turnPlan?.workflow !== "customer_service"
  ) {
    const handoffPool = availabilityPinnedCards || comparisonPinnedCards || evidencePinnedCards || priorEvidencePinnedCards || pool;
    // Repeated bot-directed frustration → escalate to a human instead of
    // looping. Count user turns that read as confused/hostile across the
    // conversation; two or more arms the handoff (the detector still requires
    // the LATEST message to be frustrated).
    const frustrationTurns = (Array.isArray(messages) ? messages : []).filter(
      (m) => m?.role === "user" && typeof m.content === "string" &&
        (isOrthoticHostileReply(m.content) || isOrthoticConfusionReply(m.content)),
    ).length;
    const handoff = detectSupportHandoffNeed({
      text: fullResponseText,
      ctx,
      pool: handoffPool,
      validation: null, // validation_failed is decided in the runner
      qualitySignals,
      productSearchAttempted,
      frustrationEscalated: frustrationTurns >= 2,
    });
    // A handoff CTA opens LIVE CHAT (Zendesk/Intercom/Gorgias) via the widget's
    // support_cta button — the Support Hub URL is only a fallback. So we emit a
    // support_cta event, NOT the plain type:"link" anchor, and never the generic
    // CTA. Gated on supportConfigured so a blank supportUrl ships no fake button.
    if (handoff.mode === "hard") {
      fullResponseText = buildSupportHandoffText({ ctx, reason: handoff.reason, partial: false });
      pool = [];
      availabilityPinnedCards = null;
      comparisonPinnedCards = null;
      evidencePinnedCards = null;
      priorEvidencePinnedCards = null;
      evidenceFallbackText = null;
      genericCTA = null;
      supportCTA = null;
      supportHandoffCta = supportConfigured(ctx) ? { label: supportChatLabel(ctx), fallbackUrl: ctx.supportUrl } : null;
      qualitySignals.supportHandoffApplied = true;
      console.log(`[handoff] mode=hard reason=${handoff.reason} support=${Boolean(supportHandoffCta)} cards=0`);
    } else if (handoff.mode === "soft") {
      const line = buildSupportHandoffText({ ctx, reason: handoff.reason, partial: true });
      if (!fullResponseText.includes(line)) fullResponseText = `${fullResponseText.trim()} ${line}`.trim();
      genericCTA = null;
      supportCTA = null;
      supportHandoffCta = supportConfigured(ctx) ? { label: supportChatLabel(ctx), fallbackUrl: ctx.supportUrl } : null;
      qualitySignals.supportHandoffApplied = true;
      const cardCount = (availabilityPinnedCards || comparisonPinnedCards || pool || []).length;
      console.log(`[handoff] mode=soft reason=${handoff.reason} support=${Boolean(supportHandoffCta)} cards=${cardCount}`);
    }
  }

  console.log(`[chat] emit textLen=${fullResponseText.length} poolSize=${pool.length} searchAttempted=${productSearchAttempted}`);

  // Cost-mode observability (no behavior change): which model handled the
  // turn, and whether a Haiku turn produced a weak result that a future
  // Sonnet re-run would target. Lets us measure the cost split + the
  // escalation rate before building the actual re-run.
  {
    const esc = haikuEscalationSignal({
      isHaiku: model === HAIKU_MODEL,
      productSearchAttempted,
      poolSize: pool.length,
      textLen: fullResponseText.length,
    });
    console.log(`[model] ${ctx.shop} used=${model} escalate_signal=${esc.escalate}${esc.reason ? ` reason=${esc.reason}` : ""}`);
  }

  // Observability only — no behavior change. Flag long non-product
  // replies (text >450 chars, no pool, no search) so we can spot
  // runaway FAQ/explanation answers in the logs without truncating.
  // Threshold ≈ 4 sentences worth — generous enough to allow real
  // FAQ explanations, tight enough to surface unusual ramblings.
  if (
    fullResponseText &&
    pool.length === 0 &&
    !productSearchAttempted &&
    fullResponseText.length > 450
  ) {
    const sentenceCount = (fullResponseText.match(/[.!?](?:\s|$)/g) || []).length;
    console.log(`[chat] WARN long-non-product-reply chars=${fullResponseText.length} sentences~=${sentenceCount}`);
  }

  if (ctx.debugChatEvents) {
    controller.enqueue(encoder.encode(sseChunk({
      type: "debug",
      stage: "before_emit",
      poolSize: pool.length,
      allProductPoolSize: allProductPool.size,
      shouldAttachProducts: shouldAttachProductCardsForTurn({ text: fullResponseText, ctx, recommenderAskedForMoreInfo }),
      resolverPromisedRecommendation: resolverPromisedRecommendation(ctx.resolverState),
      looksLikeProductPitch: looksLikeProductPitch(fullResponseText),
      scope: currentCatalogScopeFromContext(ctx),
    })));
  }

  // deferTextEmit (LLM-owns path): the grounding-retry runner may override
  // this attempt's text — shorten a recovered answer or swap in a safe
  // deterministic fallback when validation fails. The widget APPENDS text
  // chunks, so the failed text must NOT enter the stream; the caller emits
  // the authoritative final text from the returned result instead.
  if (!deferTextEmit) {
    controller.enqueue(encoder.encode(sseChunk({
      type: "text",
      text: fullResponseText
    })));
  }

  // STALE-CARDS GUARD: emit an empty products event up front so the
  // widget clears any cards left over from prior turns. The card-render
  // block below may emit a non-empty products event afterwards — the
  // widget treats each products event as a full replacement, so the last
  // one wins. Without this guard, a customer who saw "Chase Sneaker" in
  // turn 3 still sees those cards in turn 5 even after the AI pivoted to
  // recommending an orthotic and didn't search this turn.
  controller.enqueue(encoder.encode(sseChunk({
    type: "products",
    products: [],
  })));

  if (supportCTA) {
    outboundLinks.push({ url: supportCTA.url, label: supportCTA.label });
    controller.enqueue(encoder.encode(sseChunk({
      type: "link",
      url: supportCTA.url,
      label: supportCTA.label
    })));
  }

  // Handoff support CTA → live chat. A BUTTON, not an anchor: the widget calls
  // openSupportChat(fallbackUrl) which prefers Zendesk/Intercom/Gorgias and only
  // falls back to the Support Hub URL.
  if (supportHandoffCta) {
    controller.enqueue(encoder.encode(sseChunk({
      type: "support_cta",
      label: supportHandoffCta.label,
      fallbackUrl: supportHandoffCta.fallbackUrl || "",
    })));
  }

  if (!supportCTA && !supportHandoffCta && genericCTA && !evidencePinnedCards && !priorEvidencePinnedCards && ctx.turnPlan?.workflow !== "availability" && ctx.turnPlan?.workflow !== "prior_evidence_availability" && ctx.turnPlan?.workflow !== "comparison") {
    outboundLinks.push({ url: genericCTA.url, label: genericCTA.label });
    controller.enqueue(encoder.encode(sseChunk({
      type: "link",
      url: genericCTA.url,
      label: genericCTA.label,
    })));
  }

  if (detectUserSignupIntent(ctx.userText) || detectAiSignupMention(fullResponseText)) {
    hasKlaviyoForm = true;
    controller.enqueue(encoder.encode(sseChunk({ type: "klaviyo_form" })));
  }

  // TurnPlan card-display authority. When the plan says products must be
  // shown (availability/show_availability, comparison/show), the cards are
  // load-bearing for the answer — never suppress them just because the text
  // is short or carries choice buttons. The plan overrides the chip heuristic.
  const planDisplay = ctx?.turnPlan?.productDisplayPolicy;
  const planForcesCards = planForcesProductDisplay(ctx?.turnPlan);

  const hasChoiceButtonsForCards = hasChoiceButtons(fullResponseText);
  let suppressCardsForChips = false;
  if (planForcesCards && hasChoiceButtonsForCards && pool.length > 0) {
    console.log(`[chat] turn-plan(${ctx.turnPlan.workflow}/${planDisplay}): keeping ${pool.length} cards despite choice buttons — plan requires product display`);
  } else if (hasChoiceButtonsForCards && pool.length > 0) {
    const firstChipIdx = fullResponseText.indexOf("<<");
    const beforeChips = firstChipIdx >= 0
      ? fullResponseText.slice(0, firstChipIdx).trim()
      : fullResponseText.trim();
    const beforeLower = beforeChips.toLowerCase();
    const usesPluralIntro = hasPluralIntroFraming(beforeChips);
    const namesPoolProduct = pool.some((card) => {
      const title = String(card.title || "").trim().toLowerCase();
      return title.length >= 5 && beforeLower.includes(title);
    });
    const looksLikePresentation = usesPluralIntro || namesPoolProduct;
    suppressCardsForChips = !looksLikePresentation;
    if (suppressCardsForChips) {
      console.log(`[chat] suppressing ${pool.length} cards: turn has choice buttons + no product presentation in text`);
    } else {
      console.log(`[chat] keeping ${pool.length} cards despite choice buttons: text presents products (pluralIntro=${usesPluralIntro}, namedTitle=${namesPoolProduct}, len=${beforeChips.length})`);
    }
  }

  if (suppressCardsForChips && fullResponseText) {
    const before = fullResponseText;
    const cleaned = stripLineupPromiseSentences(before);
    if (cleaned !== before) {
      console.log(
        `[chat] suppressed-cards: stripped ${before.length - cleaned.length} chars of lineup-promise text (now ${cleaned.length})`,
      );
      fullResponseText = cleaned;
    }
  }

  if (priorEvidencePinnedCards) {
    // Prior-evidence availability owns the final cards: the previously-shown
    // products remapped to the new constraint (subset of the prior families).
    // Emit verbatim, bypass the scorer. No broad CTA — these ARE the answer.
    const { products: deduped } = prepareProductCardsForTurn(priorEvidencePinnedCards);
    finalProductCards = deduped;
    console.log(`[prior-evidence] finalCards=${deduped.length}`);
    if (deduped.length > 0) {
      controller.enqueue(encoder.encode(sseChunk({ type: "products", products: deduped })));
    }
    console.log(`[cta] ${ctx.shop} broad CTA suppressed: prior_evidence_availability turn (pinned remap)`);
  } else if (availabilityPinnedCards) {
    // Availability Truth owns the final cards. Emit them verbatim — bypass the
    // scorer, group guards, alignment, and chip-suppression entirely. This is
    // the ONLY thing allowed to set finalProductCards on an availability turn.
    const { products: deduped } = prepareProductCardsForTurn(availabilityPinnedCards);
    finalProductCards = deduped;
    console.log(`[availability-truth] finalCards=${deduped.length}`);
    if (deduped.length > 0) {
      controller.enqueue(encoder.encode(sseChunk({ type: "products", products: deduped })));
      if (deduped.length === 1) {
        const vizEvent = buildVisualizeCtaEvent({ config: ctx.shopConfig, product: deduped[0], messages: ctx.messages, isInsoleRecommendation: recommenderInvokedThisTurn });
        if (vizEvent) {
          controller.enqueue(encoder.encode(sseChunk(vizEvent)));
          console.log(`[chat] ${ctx.shop} visualize_cta emitted for "${vizEvent.productTitle}"`);
        }
      }
    }
    // No collection/auto-search CTA on availability turns — the family card (and
    // its product page) is the answer; a broad "View All …" link would make a
    // precise yes/no/unknown look like browse mode.
    console.log(`[cta] ${ctx.shop} broad CTA suppressed: availability turn (pinned cards)`);
  } else if (comparisonPinnedCards) {
    // Comparison owns the final cards: one representative per named family.
    // Emit verbatim, bypass the scorer. No broad "View All" CTA — the two cards
    // ARE the comparison.
    const { products: deduped } = prepareProductCardsForTurn(comparisonPinnedCards);
    finalProductCards = deduped;
    console.log(`[comparison] finalCards=${deduped.length}`);
    if (deduped.length > 0) {
      controller.enqueue(encoder.encode(sseChunk({ type: "products", products: deduped })));
    }
    console.log(`[cta] ${ctx.shop} broad CTA suppressed: comparison turn (pinned cards)`);
  } else if (evidencePinnedCards) {
    // EvidencePlan owns the final cards (multi_recommendation = one per slot;
    // compatibility / named_product_advisory = the named product; product_focus /
    // cart_handoff = the focused card; display_recovery = the prior cards). Emit
    // verbatim, bypass the scorer and alignment so category-level answer language
    // can't wipe them.
    const { products: deduped } = prepareProductCardsForTurn(evidencePinnedCards);
    finalProductCards = deduped;
    console.log(`[evidence-plan] finalCards=${deduped.length} (${ctx.turnPlan?.workflow})`);
    if (deduped.length > 0) {
      controller.enqueue(encoder.encode(sseChunk({ type: "products", products: deduped })));
      // A single focused/pinned card can carry the See-It-Styled CTA.
      if (deduped.length === 1) {
        const vizEvent = buildVisualizeCtaEvent({ config: ctx.shopConfig, product: deduped[0], messages: ctx.messages, isInsoleRecommendation: recommenderInvokedThisTurn });
        if (vizEvent) {
          controller.enqueue(encoder.encode(sseChunk(vizEvent)));
          console.log(`[chat] ${ctx.shop} visualize_cta emitted for "${vizEvent.productTitle}"`);
        }
      }
    }
    console.log(`[cta] ${ctx.shop} broad CTA suppressed: ${ctx.turnPlan.workflow} turn (pinned evidence)`);
  } else if (pool.length > 0 && fullResponseText && !suppressCardsForChips) {
    const textLower = fullResponseText.toLowerCase();
    const saysNoMatch = detectAiNoMatchPhrasing(fullResponseText);

    // When find_similar_products ran, drop every card whose handle or style
    // family matches the reference — otherwise Jillian from an earlier
    // search_products call wins the scoring pass because the AI text still
    // names "Jillian" as the comparison point.
    let filteredPool = (excludedFamilies.size === 0 && excludedHandles.size === 0)
      ? pool
      : pool.filter((card) => {
          const handle = String(card.handle || "").toLowerCase();
          if (excludedHandles.has(handle)) return false;
          const fam = titleStyleFamily(card.title || "");
          if (fam && excludedFamilies.has(fam)) return false;
          return true;
        });

    if (ctx.activeCategoryGroup) {
      const textLowerForProtection = fullResponseText.toLowerCase();
      const protectedHandles = new Set();
      for (const card of filteredPool) {
        const title = String(card.title || "").trim().toLowerCase();
        if (title.length >= 5 && textLowerForProtection.includes(title)) {
          protectedHandles.add(card.handle);
        }
      }

      const replyDiverges = textIntentDivergesFromGroup(
        fullResponseText,
        ctx.activeCategoryGroup,
        ctx.merchantGroups,
      );

      if (replyDiverges) {
        // The AI's reply is about a different group than the locked
        // one — switch the filter to that group instead of skipping
        // entirely. Skipping was the old behavior and let wrong cards
        // through (e.g. customer asks for orthotics → conversation
        // locks Footwear via a chip → AI says "the right orthotic
        // is X" but cards are sneakers because the filter was bypassed).
        // Now we filter to whatever group the reply actually mentions.
        const replyGroups = matchingGroupsForText(fullResponseText, ctx.merchantGroups, { includeTriggers: true });
        if (replyGroups.length === 1) {
          const replyGroup = replyGroups[0];
          const beforeGroup = filteredPool.length;
          const groupScoped = filteredPool.filter(
            (card) => protectedHandles.has(card.handle) || cardMatchesActiveGroup(card, replyGroup),
          );
          if (groupScoped.length > 0) {
            console.log(`[chat] product-card group guard: SWITCH locked=${ctx.activeCategoryGroup.name || "-"} → reply-matched=${replyGroup.name} (${groupScoped.length}/${beforeGroup}${protectedHandles.size > 0 ? `, protected ${protectedHandles.size} AI-named` : ""})`);
            filteredPool = groupScoped;
          } else if (protectedHandles.size > 0) {
            // No cards match the divergent group, but the AI named
            // some cards from the original pool by title. Trust the
            // AI's named recommendations and skip the wipe.
            const named = filteredPool.filter((c) => protectedHandles.has(c.handle));
            console.log(`[chat] product-card group guard: SKIP wipe — keeping ${named.length} AI-named card(s) over divergent ${replyGroup.name} match`);
            filteredPool = named;
          } else if (!isSingularPrescriptive(fullResponseText)) {
            // Generic / plural-intro framing ("here are some great
            // options with arch support") often shares vocabulary
            // with adjacent groups — but isn't a specific
            // recommendation from those groups. Wiping the active-
            // group cards in that case turns the right answer into
            // a text-only response with zero cards. Keep the cards
            // and let the customer browse what the search returned.
            console.log(`[chat] product-card group guard: SKIP wipe — reply is generic (no singular-prescriptive claim) so ${replyGroup.name} mention is incidental vocabulary`);
          } else {
            // Reply mentions a group but no cards match it AND the
            // AI made a singular-prescriptive claim AND didn't name
            // any active-group card — likely a hallucination. Wipe
            // so the empty-pool repair turns this into the dead-end
            // fallback rather than rendering wrong cards beneath
            // text the AI got right.
            console.log(`[chat] product-card group guard: reply mentions ${replyGroup.name} but no matching cards in pool — wiping`);
            filteredPool = [];
          }
        } else {
          console.log(`[chat] product-card group guard: skip — reply matches ${replyGroups.length} groups, ambiguous`);
        }
      } else {
        const beforeGroup = filteredPool.length;
        const groupScoped = filteredPool.filter(
          (card) => protectedHandles.has(card.handle) || cardMatchesActiveGroup(card, ctx.activeCategoryGroup),
        );
        if (groupScoped.length === 0 && beforeGroup > 0) {
          // Fail-open: the locked group wiped every card. This is almost
          // always a STALE lock — e.g. the group locked to Footwear from
          // an opening "men's/women's footwear" framing, but the customer
          // is actually buying Orthotics (which go INSIDE footwear), so
          // every orthotic card fails the Footwear test. Rather than ship
          // an empty bubble, prefer the cards that match the customer's
          // in-memory product category; only if that also empties do we
          // fall back to the raw search pool.
          const memCategory = String(ctx.sessionMemory?.explicit?.category || "").toLowerCase();
          const categoryGroup = memCategory && Array.isArray(ctx.merchantGroups)
            ? ctx.merchantGroups.find((g) =>
                (g?.categories || []).some((c) => String(c).toLowerCase() === memCategory) ||
                String(g?.name || "").toLowerCase() === memCategory)
            : null;
          const categoryScoped = categoryGroup
            ? filteredPool.filter((card) => protectedHandles.has(card.handle) || cardMatchesActiveGroup(card, categoryGroup))
            : [];
          if (categoryScoped.length > 0) {
            console.log(`[chat] product-card group guard: stale lock=${ctx.activeCategoryGroup.name || "-"} wiped all → re-scoped to in-memory category group=${categoryGroup.name || memCategory} (${categoryScoped.length}/${beforeGroup})`);
            filteredPool = categoryScoped;
          } else {
            console.log(`[chat] product-card group guard: WIPED ALL ${beforeGroup} for group=${ctx.activeCategoryGroup.name || "-"} → falling back to unfiltered`);
          }
        } else {
          if (groupScoped.length !== beforeGroup) {
            console.log(
              `[chat] product-card group guard: kept ${groupScoped.length}/${beforeGroup} for group=${ctx.activeCategoryGroup.name || "-"}${protectedHandles.size > 0 ? ` (protected ${protectedHandles.size} AI-named)` : ""}`,
            );
          }
          filteredPool = groupScoped;
        }
      }
    }

    // When get_fit_recommendation ran, the customer is asking about ONE
    // specific product. Narrow the display to just the focused handle(s),
    // so a search that over-matched on generic words ("arch support
    // sneaker") doesn't show random sibling products alongside.
    if (focusedHandles.size > 0) {
      const focused = filteredPool.filter((card) =>
        focusedHandles.has(String(card.handle || "").toLowerCase()),
      );
      if (focused.length > 0) filteredPool = focused;
    }

    // Named-product / card-pool mismatch guard.
    //
    // Live 2026-06-04: customer asked "do you have andrea in size 9?".
    // AI used lookup_sku, wrote great text about the Andrea Quarter
    // Strap Wedge — Black, but the displayed card was a Mila Low
    // Boot from a prior turn's pool. Customer reads two contradictory
    // products on the same turn.
    //
    // detectNamedProductMismatch extracts bold product references
    // from the AI's text (markdown **X**) and checks whether ANY
    // pool card shares a style family with them. When there's no
    // overlap, wipe the pool — better to show no card than the
    // wrong one. Pure title-token math, no merchant vocabulary.
    //
    // SKIPPED on the LLM-owns path: the grounding validator covers
    // the text side (ungrounded product names trigger a model retry
    // with the error spelled out), so a text/card mismatch resolves
    // by FIXING THE TEXT instead of silently wiping correct cards.
    if (!llmOwnsTurnActive() && filteredPool.length > 0 && fullResponseText) {
      const m = detectNamedProductMismatch(fullResponseText, filteredPool);
      if (m.textFamilies.length > 0 && !m.overlap) {
        console.log(
          `[chat] ${ctx.shop} named-product mismatch guard: text bolds [${m.textFamilies.join(",")}] ` +
            `but pool families [${m.poolFamilies.join(",")}] don't overlap — wiping ${filteredPool.length} card(s)`,
        );
        filteredPool = [];
      }
    }

    // Definition / technology-name guard.
    //
    // Live 2026-06-04: customer asked "what is bio rocker?". RAG
    // returned 0 chunks (knowledge file has no bio-rocker entry).
    // The LLM explained the technology in prose without bolding the
    // name, then called search_products("bio rocker") which returned
    // 4 unrelated products (Savannah Quarter Strap Sandal, Darcy
    // Slip-On Sneaker, Jenny Slide Sandal, Donna Thong). The earlier
    // named-product guard only fires on **bolded** mentions, so it
    // missed this — the customer saw an explanation of bio rocker
    // accompanied by random sandals that don't actually use it.
    //
    // For definition questions ("what is X?", "tell me about X",
    // "explain X", "how does X work"), require that EVERY remaining
    // card has canonical catalog evidence for the topic. Valid proof
    // may live in description, tags, product/variant attributes, or
    // enrichment — not only the visible title.
    // If none do, wipe the pool — text-only explanation is correct.
    // Compare turn for UltraSky which DID bold the name: the prior
    // guard fired and wiped 6 cards. This guard generalizes that
    // behavior to the bolded-or-not case.
    //
    // SKIPPED on the LLM-owns path. Live trace 2026-06-10: the guard
    // matched "what's the spec on the Reagan boot?" as a definition
    // question (it isn't — it's a product-fact ask), wiped 6 valid
    // Reagan cards, and the grounding validator then saw the model's
    // correct "**Reagan Ankle Boot**" answer against an EMPTY display
    // pool → 3 retry attempts (~35s) for an answer that was right the
    // first time. The validator + evidence-pool check supersede this.
    if (!llmOwnsTurnActive() && filteredPool.length > 0 && ctx.latestUserMessage) {
      const msg = String(ctx.latestUserMessage).trim();
      // Match common definition / technology-question shapes and
      // capture the topic. Greedy capture, then strip filler suffixes
      // ("work", "mean", "technology", "shoes", etc.) so the topic
      // is the bare term.
      const defPatterns = [
        /^\s*(?:what(?:'s|\s+is|\s+are|\s+does)|tell\s+me\s+about|explain|describe|define|what\s+do(?:es)?\s+(?:the\s+)?)\s+(.+?)\s*\??\s*$/i,
        /^\s*(?:how\s+(?:does|do)\s+(?:the\s+)?)(.+?)\s+(?:work|operate|function)s?\s*\??\s*$/i,
      ];
      let topicRaw = null;
      for (const re of defPatterns) {
        const m = msg.match(re);
        if (m) { topicRaw = m[1]; break; }
      }
      if (topicRaw) {
        const topic = String(topicRaw)
          .toLowerCase()
          .replace(/^\s*(?:the|a|an)\s+/i, "")
          .replace(/\s+(?:work|mean|stand\s+for|do)$/i, "")
          .replace(/\s+(?:technology|tech|material|foam|shoes?|sole|outsole|footbed|insole|cushion(?:ing)?|feature|line|collection)$/i, "")
          .trim();
        if (topic.length >= 3) {
          const matching = filteredPool.filter((card) =>
            matchCatalogRequirement(card, topic).matched,
          );
          if (matching.length === 0) {
            console.log(
              `[chat] ${ctx.shop} definition-question guard: customer asked "what is ${topic}?" ` +
                `but 0 of ${filteredPool.length} card(s) have catalog evidence for "${topic}" ` +
                `— wiping pool (text-only answer)`,
            );
            filteredPool = [];
          } else if (matching.length < filteredPool.length) {
            console.log(
              `[chat] ${ctx.shop} definition-question guard: keeping ${matching.length}/${filteredPool.length} card(s) ` +
                `that mention "${topic}"`,
            );
            filteredPool = matching;
          }
        }
      }
    }

    const userTextLower = (ctx.userText || "").toLowerCase();
    const scored = filteredPool.map((card) => ({
      card,
      score: scoreCardAgainstText(card, textLower, userTextLower),
    }));
    scored.sort((a, b) => b.score - a.score);

    // Per-shop card cap, set in chat action from config.productCardStyle.
    // Horizontal layout = 3 (legacy); showcase layout = 10 (scroll-snap row).
    const cardCap = ctx.productCardCap || 3;

    const latestMsgForIntent = String(ctx.latestUserMessage || "");
    let singularIntent = detectSingularIntent(latestMsgForIntent);

    if (ctx?.sessionMemory?.latestTurnIntent?.reason === "compare_request") {
      console.log(`[chat] singular-suppress: comparison phrasing in latest message — keeping plural pool`);
    }

    if (singularIntent && Array.isArray(ctx.fullCatalogCategories) && ctx.fullCatalogCategories.length > 0) {
      const lower = latestMsgForIntent.toLowerCase();
      const matchedPlural = ctx.fullCatalogCategories.find((cat) => {
        const c = String(cat || "").toLowerCase().trim();
        if (!c) return false;
        const pluralForms = c.endsWith("s") ? [c] : [c + "s", c + "es"];
        return pluralForms.some((p) => new RegExp(`\\b${escapeRe(p)}\\b`).test(lower));
      });
      if (matchedPlural) {
        console.log(`[chat] singular-suppress: latest message names "${matchedPlural}" (plural catalog noun) — keeping plural pool`);
        singularIntent = false;
      }
    }

    const baseSku = (s) => String(s).toUpperCase().replace(/[A-Z]$/, "");
    const mentionedSkus = fullResponseText.match(SKU_PATTERN) || [];
    let skuNarrowedCards = null;
    if (mentionedSkus.length > 0) {
      const wantedBases = new Set(mentionedSkus.map(baseSku));
      const skuMatches = filteredPool.filter((card) => {
        const cardSkus = [
          ...skusFromCardText(card.title),
          ...skusFromCardText(card.handle),
        ];
        return cardSkus.some((s) => wantedBases.has(baseSku(s)));
      });
      if (skuMatches.length > 0) {
        skuNarrowedCards = skuMatches.slice(0, cardCap);
        console.log(
          `[chat] SKU-narrow: text mentions ${[...wantedBases].join(",")} → showing ${skuNarrowedCards.length} of ${filteredPool.length} pool cards`,
        );
      }
    }

    let titleNarrowedCards = null;
    if (!skuNarrowedCards && filteredPool.length > 1) {
      const sortedByLen = [...filteredPool].sort(
        (a, b) => (String(b.title || "").length) - (String(a.title || "").length),
      );
      const consumed = [];
      const titleMatches = [];
      for (const card of sortedByLen) {
        const title = String(card.title || "").trim().toLowerCase();
        if (title.length < 5) continue;
        const idx = textLower.indexOf(title);
        if (idx === -1) continue;
        const end = idx + title.length;
        const overlap = consumed.some(([s, e]) => idx >= s && end <= e);
        if (overlap) continue;
        titleMatches.push(card);
        consumed.push([idx, end]);
      }
      // Narrowing decision tree:
      //   singularIntent + ≥2 named  → force to top 1 (customer asked
      //                                "which is best", AI hedged with
      //                                multiple — give them the answer)
      //   ≥2 named                    → narrow to those named
      //   1 named + singularIntent    → narrow to that 1
      //   1 named + plural intent     → SKIP (let pool through)
      if (singularIntent && titleMatches.length > 1) {
        titleNarrowedCards = [titleMatches[0]];
        console.log(
          `[chat] title-narrow: singular intent + AI named ${titleMatches.length} → forcing 1 card (top match)`,
        );
      } else if (titleMatches.length >= 2 && titleMatches.length < filteredPool.length) {
        titleNarrowedCards = titleMatches.slice(0, cardCap);
        console.log(
          `[chat] title-narrow: text names ${titleMatches.length} card(s) by title → showing ${titleNarrowedCards.length} of ${filteredPool.length} pool cards`,
        );
      } else if (titleMatches.length === 1 && singularIntent && titleMatches.length < filteredPool.length) {
        titleNarrowedCards = [titleMatches[0]];
        console.log(
          `[chat] title-narrow: text names 1 card + singular intent → showing 1 of ${filteredPool.length} pool cards`,
        );
      } else if (titleMatches.length === 1 && !singularIntent) {
        console.log(
          `[chat] title-narrow: SKIP — AI named 1 card but customer asked plural; showing full pool of ${filteredPool.length}`,
        );
      }
    }

    // Kept for the coherence guard below — when the AI uses
    // prescriptive singular language ("X is your best fit") but the
    // pool has nothing close to it, we replace the text rather than
    // letting the customer read one product name above a different
    // product card.
    const singularPrescriptive = isSingularPrescriptive(fullResponseText);

    // saysNoMatch override: if the AI named ANY pool product by title
    // OR uses plural-intro framing ("here are our closest...") OR uses
    // pivot phrasing ("we don't have X, but here are Y") it's pivoting,
    // not denying. Treat as not-a-denial so cards still render.
    //
    // Without this, partial-denial pivots like "We don't have an exact
    // red match, but here are our closest options" leave the customer
    // reading the apology with no cards beneath — broken UX, especially
    // when the search layer already relaxed the filter and found close
    // matches.
    const aiNamesAnyPoolProduct = filteredPool.some((card) => {
      const title = String(card.title || "").trim().toLowerCase();
      return title.length >= 5 && textLower.includes(title);
    });
    const aiUsesPresentationFraming = hasPluralIntroFraming(fullResponseText);
    // Pivot phrasing: "we don't have X, but [...] here/these/those/our/all
    // of these/etc.". Allow up to ~30 chars of filler between 'but' and
    // the presentational pronoun so phrases like 'but all of these
    // sandals are tagged for bunions' or 'but I do have a few options'
    // count as a pivot. Production trace: customer asked for a yellow
    // sandal; AI replied 'We don't have an exact yellow option right
    // now, but all of these sandals are specifically tagged for
    // bunions...'. Without the relaxed match, saysNoMatch stayed true,
    // the card pool was suppressed, and the customer saw the 'we don't
    // have' apology with no products beneath.
    const aiUsesPivotPhrasing = detectAiPivotPhrasing(fullResponseText);
    const aiPivotsOrPresents = aiNamesAnyPoolProduct || aiUsesPresentationFraming || aiUsesPivotPhrasing;
    const effectiveSaysNoMatch = saysNoMatch && !aiPivotsOrPresents;
    if (saysNoMatch && aiPivotsOrPresents) {
      const reason = aiNamesAnyPoolProduct ? "named a pool product" :
                     aiUsesPresentationFraming ? "plural-intro framing" :
                     "pivot phrasing";
      console.log(`[chat] saysNoMatch override: ${reason} despite denial words — treating as pivot, not denial`);
    }

    let cards;
    if (skuNarrowedCards) {
      cards = skuNarrowedCards;
    } else if (titleNarrowedCards) {
      cards = titleNarrowedCards;
    } else if (singularIntent && scored.length > 0 && scored[0].score >= 0.5) {
      // Customer asked about ONE thing — show just the top match.
      cards = [scored[0].card];
      console.log(`[chat] singular-narrow: customer expressed singular intent → 1 card`);
    } else if (!effectiveSaysNoMatch && scored.length > 0) {
      // Default: show the top of the ranked pool (siblings folded).
      // Plural is the assumed mode — if the customer wanted one item
      // they would have used singular phrasing or named a SKU.
      cards = dropSiblingCards(scored, textLower).slice(0, cardCap).map((s) => s.card);
    }

    // Text-card coherence guard: if the AI used singular-prescriptive
    // language ("is the right pick", etc.) but no card scored ≥0.4
    // (i.e. no card title meaningfully matches the AI's claim), the AI
    // is naming a product that isn't really in the pool. Replace the
    // text with neutral framing so the customer doesn't read "Kids
    // Orthotics is the right pick" while seeing a Unisex Edge card.
    if (
      singularPrescriptive &&
      cards && cards.length > 0 &&
      (scored.length === 0 || scored[0].score < 0.4)
    ) {
      console.log(`[chat] coherence guard: AI named a product but no card matches well (top score=${scored[0]?.score?.toFixed(2) || "n/a"}) — neutral text`);
      fullResponseText = "Here's an option that might work — let me know if you'd like to look at something different.";
    }


    // Product/text alignment (answer workflows). Text and cards must come from
    // the SAME current-turn evidence. If the answer names a family the
    // displayed cards don't represent (stale-memory contamination — text
    // "Savannah", cards Danika/Kinsley sneakers), recover the named family from
    // the turn evidence or suppress the mismatched cards.
    if (cards && cards.length > 0 && isAnswerWorkflow(ctx?.turnPlan)) {
      const aligned = alignCardsToAnswerText({
        text: fullResponseText,
        cards,
        evidencePool: Array.from(allProductPool.values()),
        namedFamilyHint: familyFromQuery(turnEvidenceSearchInput?.query),
        namedFamilies: ctx.turnPlan?.namedFamilies || [],
        // Availability shows only the named product; advisory/comparison/
        // condition keep relevant alternatives after the named family.
        keepAlternatives: ctx.turnPlan.workflow !== "availability",
        cap: ctx.productCardCap || 6,
      });
      if (aligned.changed) {
        const condMulti = ctx.turnPlan.workflow === "condition_recommendation" || ctx.turnPlan.workflow === "multi_recommendation";
        if (aligned.cards.length === 0 && cards.length > 0 && condMulti) {
          // Requirement #6: a condition/multi answer using CATEGORY-level
          // language ("supportive sandals") must NOT wipe all current-turn
          // cards. Alignment removes hard contradictions only — never a 5→0 wipe
          // on vocabulary. Keep the top current-turn cards.
          console.log(`[chat] turn-plan(${ctx.turnPlan.workflow}): alignment would wipe ${cards.length}→0 on category-level language — keeping top current-turn card(s)`);
          cards = cards.slice(0, ctx.productCardCap || 6);
        } else {
          console.log(`[chat] turn-plan(${ctx.turnPlan.workflow}): card/text alignment ${aligned.reason} — ${cards.length}→${aligned.cards.length} card(s)`);
          cards = aligned.cards;
        }
      }
    }

    if (cards && cards.length > 0) {
      const { products: deduped, categoryCounts, genderCounts } = prepareProductCardsForTurn(cards);
      // show product cards
      finalProductCards = deduped;
      controller.enqueue(encoder.encode(sseChunk({
        type: "products",
        products: deduped
      })));

      // Visualize My Look: when EXACTLY ONE product is recommended,
      // offer the AI styling-preview CTA (distinct first chip in the
      // widget). Single-product only, feature-gated, provider+key
      // required — buildVisualizeCtaEvent returns null otherwise.
      if (deduped.length === 1) {
        const vizEvent = buildVisualizeCtaEvent({
          config: ctx.shopConfig,
          product: deduped[0],
          messages: ctx.messages,
          isInsoleRecommendation: recommenderInvokedThisTurn,
        });
        if (vizEvent) {
          controller.enqueue(encoder.encode(sseChunk(vizEvent)));
          console.log(`[chat] ${ctx.shop} visualize_cta emitted for "${vizEvent.productTitle}"`);
        } else {
          // Tell us EXACTLY why the CTA was withheld on a single-product
          // turn — otherwise a missing button is impossible to debug.
          const c = ctx.shopConfig || {};
          const prov = String(c.imageProvider || "").trim();
          const hasKey = prov === "gemini" ? Boolean(c.geminiApiKey) : prov === "openai" ? Boolean(c.openaiApiKey) : false;
          const reason = recommenderInvokedThisTurn ? "orthotic recommendation (insole — never wearable)"
            : /\b(?:insole|insert|footbed|foot[\s-]*bed)s?\b/i.test(String(deduped[0]?.title || "")) ? "product title is a standalone insole/insert"
            : !c.visualizeLookEnabled ? "feature disabled in Settings"
            : !(prov === "gemini" || prov === "openai") ? `no image provider selected (imageProvider=${JSON.stringify(c.imageProvider)})`
            : !hasKey ? `no API key saved for provider "${prov}"`
            : !(deduped[0]?.image || deduped[0]?.featuredImageUrl) ? "product has no image"
            : !deduped[0]?.handle ? "product has no handle"
            : "unknown";
          console.log(`[chat] ${ctx.shop} visualize_cta SUPPRESSED on single-product turn — reason: ${reason}`);
        }
      }

      // Collection CTA: AI-emitted <<Label|URL>> takes priority; otherwise look up
      // the dominant (category, gender) across the shown cards in the merchant's
      // configured collectionLinks mapping. Matching prefers an exact
      // category+gender rule, then falls back to a gender-agnostic rule for the
      // same category. No mapping → no CTA (avoids 404s).
      // Exact-availability turns must NOT show a broad "View All Women's
      // Sandals" collection/auto-search CTA — that makes a precise yes/no/
      // unknown answer look like browse mode. The family card (+ its product
      // page) is the answer; no broad collection link.
      const isAvailabilityTurn = ctx.turnPlan?.workflow === "availability";
      const collection = isAvailabilityTurn ? { cta: null } : extractCollectionCTA(fullResponseText);
      if (collection.cta) {
        outboundLinks.push({ url: collection.cta.url, label: collection.cta.label });
        controller.enqueue(encoder.encode(sseChunk({
          type: "link",
          url: collection.cta.url,
          label: collection.cta.label,
        })));
      } else if (isAvailabilityTurn) {
        console.log(`[cta] ${ctx.shop} broad CTA suppressed: availability turn (family-only display)`);
      } else if (isKnowledgeQuestionLocal(ctx?.latestUserMessage)) {
        // Knowledge-turn auto-search CTA suppression. Live trace
        // 2026-06-08: customer asked "what other tech do you have?",
        // LLM described technologies in prose, but the auto-search
        // CTA derived "View All Women's Orthotics" from a few cards
        // the LLM had attached — a misleading link for a tech Q&A.
        console.log(
          `[cta] ${ctx.shop} auto-search suppressed: knowledge turn — ` +
            `customer asked about technologies/materials, not browsing`,
        );
      } else {
        const productLink = resolveProductTurnLink({ categoryCounts, genderCounts, ctx });
        if (productLink.link) {
          if (productLink.kind === "auto") {
            console.log(
              `[cta] ${ctx.shop} auto-search url=${productLink.link.url} label=${JSON.stringify(productLink.link.label)} ` +
                `gender=${productLink.diagnostics.gender || "-"} category=${productLink.diagnostics.category || "-"} color=${productLink.diagnostics.color || "-"}`,
            );
          }
          outboundLinks.push(productLink.link);
          controller.enqueue(encoder.encode(sseChunk({
            type: "link",
            url: productLink.link.url,
            label: productLink.link.label,
          })));
        } else if (productLink.kind === "auto-miss") {
          console.log(
            `[cta] ${ctx.shop} auto-search NO MATCH gender=${productLink.diagnostics.gender || "-"} category=${productLink.diagnostics.category || "-"} pattern=${productLink.diagnostics.patternSet ? "set" : "unset"} overrides=${productLink.diagnostics.overrideCount || 0}`,
          );
        }
      }
    }
    // Display-boundary fallback removed. It existed because the
    // scorer used to ignore user-question-vs-card-title and would
    // drop cards to zero whenever the LLM wrote vague text ("Here
    // are some options:") without naming products. The fallback
    // then resurrected them by reading `pool` directly — which
    // bypassed every upstream guard. Fixed at the source: scorer
    // now also matches user words against card titles, so a card
    // that legitimately matches the customer's ask survives even
    // when the LLM didn't name it. If the scorer drops all cards
    // now, that's because none of them actually match — the right
    // answer is text-only, not "show whatever we had."
  }

  // ── Cards-promised-but-none-shown recovery (display invariant #4) ───────
  // If the answer TEXT presents products ("here are…", "I found 5…") but the
  // final cards came out empty while we DO have product evidence (the current
  // pool, or the prior turn's cards), that's a text/card contradiction — restore
  // the cards instead of shipping a lying cardless reply (live trace 2026-06-29:
  // "Here are our men's…" with finalCards=0 after a wrongful card-wipe). This is
  // narrowly gated (text MUST present products) — not the old blanket fallback
  // that resurrected cards under any vague "here are some options" text.
  if (
    (!Array.isArray(finalProductCards) || finalProductCards.length === 0) &&
    textPresentsProducts(fullResponseText)
  ) {
    const recoverySource = (Array.isArray(pool) && pool.length > 0)
      ? pool
      : (Array.isArray(ctx?.priorProductCards) ? ctx.priorProductCards : []);
    if (recoverySource.length > 0) {
      const cap = Math.max(1, ctx.productCardCap || 6);
      const { products: deduped } = prepareProductCardsForTurn(recoverySource.slice(0, cap));
      if (deduped.length > 0) {
        finalProductCards = deduped;
        controller.enqueue(encoder.encode(sseChunk({ type: "products", products: deduped })));
        recordTurnInvariantViolation("cards_promised_none_shown", { workflow: ctx?.turnPlan?.workflow || "-", recovered: deduped.length });
        console.log(`[chat] cards-promised recovery: text presents products but finalCards=0 — restored ${deduped.length} card(s) from ${(Array.isArray(pool) && pool.length > 0) ? "pool" : "prior"}`);
      }
    }
  }

  // ── Turn invariant log (docs/chatbot-ownership-map.md) ────────────────
  // One structured line per turn naming the answer/card owners and the card
  // counts, plus whether the safety-cleanup pipeline changed the owner's text.
  // For workflow=availability, Availability Truth's pinned cards are
  // authoritative: finalCards MUST equal pinnedCards. A mismatch means a
  // downstream mutator violated the do-not-mutate rule — logged as VIOLATION.
  {
    const workflow = ctx?.turnPlan?.workflow || "-";
    const pinned = availabilityPinnedCards || comparisonPinnedCards || evidencePinnedCards || priorEvidencePinnedCards;
    const pinnedCount = pinned ? pinned.length : null;
    // NOTE: orthotic-flow card purity is enforced PRE-EMISSION (it filters the
    // pool before the condition_recommendation pin and any product SSE), so by
    // here finalProductCards is already orthotic-pure on a non-cancel orthotic
    // turn — no post-emission drop (which would desync emitted cards vs the
    // evidence-plan finalCards log).

    const finalCount = Array.isArray(finalProductCards) ? finalProductCards.length : 0;

    // FRAGMENT GUARD. Safety cleanup (disallowed-clarifier strip, narration
    // strips) can gut an LLM answer down to a dangling fragment that references
    // a question it just removed — live trace 2026-06-30: "…What would you pick
    // first?" shipped "That one detail will get you to exactly the right pick."
    // ABOVE real product cards. Never ship fragment text over cards: rebuild a
    // clean, complete sales answer from the displayed cards instead.
    if (
      finalCount > 0 &&
      !recommenderInvokedThisTurn &&
      isStrippedFragmentText(fullResponseText) &&
      !looksLikeClarifyingQuestion(fullResponseText)
    ) {
      const rebuilt = buildCodeOwnedProductListingText({
        text: fullResponseText, cards: finalProductCards, ctx, recommenderInvoked: recommenderInvokedThisTurn,
      });
      const safeText = rebuilt.changed && rebuilt.text && rebuilt.text.trim().length >= 40
        ? rebuilt.text
        : (finalCount === 1
            ? "Here's a great option to get you started."
            : "Here are a few great options to get you started.");
      console.log(`[chat] ${ctx.shop} fragment guard: cleanup left a ${fullResponseText.trim().length}-char fragment over ${finalCount} card(s) — replaced with a complete answer`);
      fullResponseText = safeText;
    }
    const cardOwner = priorEvidencePinnedCards != null ? "prior-evidence"
      : availabilityPinnedCards != null ? "availability-truth"
      : comparisonPinnedCards != null ? "comparison"
      : evidencePinnedCards != null ? "evidence-plan"
      : finalCount > 0 ? "scorer" : "none";
    resolvedCardOwner = cardOwner;
    const textCleanupChanged = ownedTextSnapshot != null && ownedTextSnapshot !== fullResponseText;

    // STATE / SCOPE OWNERSHIP OBSERVABILITY (Class 1-5). Parse this turn's
    // positive vs negative category constraints + active product context, run
    // the new hard invariants, and emit one self-explanatory turn record.
    const firedInvariants = [];
    const catConstraints = parseCategoryConstraints(ctx?.latestUserMessage || "");
    if (negationCorruptedPositiveCategory(ctx?.latestUserMessage || "")) {
      recordTurnInvariantViolation("current_turn_negation_corrupted_positive_category", {
        positive: [...catConstraints.positive], rejected: [...catConstraints.rejected],
      });
      firedInvariants.push("current_turn_negation_corrupted_positive_category");
    }
    // availability text ↔ shown-card color truth.
    if ((workflow === "availability" || workflow === "prior_evidence_availability") && finalCount > 0) {
      const mismatchColor = availabilityTextCardColorMismatch({
        text: fullResponseText, cards: finalProductCards,
        knownColors: Array.isArray(ctx?.catalogColorList) ? ctx.catalogColorList : [],
      });
      if (mismatchColor) {
        recordTurnInvariantViolation("availability_text_card_color_mismatch", { color: mismatchColor });
        firedInvariants.push("availability_text_card_color_mismatch");
      }
    }
    const activeProductCtx = ctx?.focusProduct
      ? { family: titleStyleFamily(ctx.focusProduct.title || ""), title: ctx.focusProduct.title }
      : null;

    // ── OWNERSHIP-CONSOLIDATION INVARIANTS (TurnPlan is the only owner) ──────
    // (a) The final card/answer owner must be AUTHORIZED for TurnPlan's workflow.
    //     A rogue owner that claimed a turn TurnPlan assigned elsewhere fires
    //     unauthorized_owner_for_workflow (observability — surfaces any owner the
    //     gating above missed, without dropping a legitimately-pinned card).
    for (const owner of new Set([cardOwner, answerOwner])) {
      if (!owner || isWorkflowAgnosticOwner(owner)) continue;
      if (!ownerAuthorizedForWorkflow(owner, workflow)) {
        recordTurnInvariantViolation("unauthorized_owner_for_workflow", { workflow, owner });
        firedInvariants.push("unauthorized_owner_for_workflow");
      }
    }
    // (b) Every final card must be from THIS turn's evidence universe
    //     (allProductPool accumulates every pinned/searched/re-pinned card,
    //     including deliberate prior-evidence re-pins). Record-only for non-scorer
    //     owners (they have their own repair); the scorer path repairs below.
    if (finalCount > 0) {
      const poolCards = Array.from(allProductPool.values());
      const stray = cardsNotInEvidencePool({ finalCards: finalProductCards, evidencePool: poolCards });
      if (stray.length > 0 && cardOwner !== "scorer") {
        recordTurnInvariantViolation("final_card_not_in_current_evidence", {
          workflow, cardOwner, count: stray.length, cards: stray.map((c) => c?.handle || c?.title),
        });
        firedInvariants.push("final_card_not_in_current_evidence");
      }
      // (c) The answer text must not NAME a product that was in the evidence pool
      //     but was dropped from the final cards (copy references a product the
      //     customer can't see). Only when cards are shown.
      const poolFamilies = poolCards.map((c) => String(c?._family || c?.family || c?.title || "")).filter(Boolean);
      const named = answerNamesProductNotInEvidence({
        text: fullResponseText, cards: finalProductCards, knownFamilies: poolFamilies,
      });
      if (named) {
        recordTurnInvariantViolation("answer_names_product_not_in_evidence", { workflow, family: named });
        firedInvariants.push("answer_names_product_not_in_evidence");
      }
    }

    logTurnInvariant({
      workflow, answerOwner, cardOwner, finalCards: finalCount, path: "agentic-loop",
      activeOwner: answerOwner,
      activeProductContext: activeProductCtx,
      positiveConstraints: [...catConstraints.positive],
      negativeConstraints: [...catConstraints.rejected],
      finalCardOwner: cardOwner,
      invariantFired: firedInvariants,
      extra: `pinnedCards=${pinnedCount == null ? "-" : pinnedCount} textCleanupChanged=${textCleanupChanged ? "yes" : "no"}`,
    });
    if ((workflow === "availability" || workflow === "comparison") && pinnedCount != null && finalCount !== pinnedCount) {
      recordTurnInvariantViolation("pinned_cards_mutated", { workflow, pinned: pinnedCount, final: finalCount });
    }
    // Two-family comparison must never flood the carousel.
    if (workflow === "comparison" && finalCount > 4) {
      recordTurnInvariantViolation("comparison_carousel_flood", { final: finalCount });
    }
    // Comparison cards are owned by the comparison pin — the scorer must NEVER
    // own a comparison turn that ships cards. (cardOwner=scorer here means the
    // pin missed and the retry/finalization leaked scorer cards.)
    if (workflow === "comparison" && finalCount > 0 && cardOwner !== "comparison") {
      recordTurnInvariantViolation("comparison_scorer_takeover", { cardOwner, final: finalCount });
    }
    // Prior-evidence availability: cards are a deterministic remap of the prior
    // displayed families. The scorer must NEVER own this turn, and every final
    // card must belong to a previously-shown family (no random alternates).
    if (workflow === "prior_evidence_availability") {
      if (finalCount > 0 && cardOwner !== "prior-evidence" && cardOwner !== "availability-truth") {
        recordTurnInvariantViolation("prior_evidence_scorer_takeover", { cardOwner, final: finalCount });
      }
      const priorFams = new Set(
        (Array.isArray(ctx?.priorProductCards) ? ctx.priorProductCards : [])
          .map((c) => familyOfTitle(c?.title || "")).filter(Boolean),
      );
      const strayCard = (finalProductCards || []).find((c) => {
        const f = familyOfTitle(c?.title || "");
        if (!f || priorFams.size === 0 || priorFams.has(f)) return false;
        // The broaden fallback DELIBERATELY surfaces alternates from non-prior
        // families when no prior style offered the asked width/size/color — those
        // are intentional, not strays.
        const k = String(c?.handle || c?.title || "").toLowerCase();
        return !priorEvidenceBroadenHandles.has(k);
      });
      if (strayCard) {
        recordTurnInvariantViolation("prior_evidence_stray_card", { card: strayCard.title, priorFamilies: [...priorFams] });
      }
      // ZERO-CARD CONVERSION (#4): a broad availability follow-up ("what about
      // wide widths?", "do those come in black?", "any waterproof?") whose
      // broaden search DID return gender-correct products must convert them into
      // cards. Search-found + show_availability + finalCards=0 means the owner
      // found evidence but failed to display it (live trace 2026-06-30:
      // filtered=8 → finalCards=0).
      if (priorEvidenceSearchFound && planForcesProductDisplay(ctx?.turnPlan) && finalCount === 0) {
        recordTurnInvariantViolation("prior_evidence_zero_cards", { workflow, searchFound: true });
      }
    }
    // GENERALIZED INVARIANT (#4): any TurnPlan-pinned workflow that ships cards
    // must NOT be scorer-owned — the deterministic selector owns them. Catches
    // multi_recommendation / compatibility / named_product_advisory leaks too,
    // not just comparison / prior_evidence above.
    if (plannedWorkflowCardOwnerViolation({ workflow, finalCards: finalCount, cardOwner })) {
      recordTurnInvariantViolation("pinned_workflow_scorer_takeover", { workflow, final: finalCount });
    }
    // GENERALIZED INVARIANT (#5): searchRequired + display=show must attempt a
    // search. If it didn't, a downstream gate silently refused a TurnPlan-
    // required search (the workflow never changed to text-only/suppress).
    if (plannedSearchSkippedViolation({ plan: ctx?.turnPlan, searchAttempted: productSearchAttempted })) {
      // A search was required but never attempted. Two legitimate (non-violation)
      // cases:
      //  1) a REWRITE-ONLY retry that reuses the prior attempt's deterministic
      //     evidence (pinned availability/comparison/evidence cards) — it
      //     intentionally does NOT re-search; flagging it burns the retry budget
      //     on a turn that already has the right cards (live QA 2026-06-30:
      //     Savannah 7-wide availability rewrite tripped this).
      //  2) the forced-search layer DELIBERATELY refused (no concrete commerce
      //     constraint, or the reply was a clarifying question) — a downgrade.
      // Only a search that was attemptable yet skipped is a real breach.
      const pinnedThisTurn = availabilityPinnedCards != null || comparisonPinnedCards != null ||
        evidencePinnedCards != null || priorEvidencePinnedCards != null;
      if (rewriteOnlyRetry && pinnedThisTurn) {
        console.log(`[chat] turn-plan(${workflow}): rewrite-only retry reusing pinned evidence — search not re-attempted (no violation)`);
      } else if (finalCount > 0) {
        // SEARCH-SATISFIED: the turn displays product cards, so a deterministic
        // forced/candidate search DID produce evidence this turn even if the
        // boolean searchAttempted flag wasn't threaded through the path that
        // attached them (e.g. resolver candidate cards on a condition
        // recommendation). Cards-shown is the real "search satisfied" signal —
        // do not falsely flag it (live trace 2026-06-30: forced search ran +
        // cards attached, yet search_required_not_attempted fired).
        console.log(`[chat] turn-plan(${workflow}): searchRequired satisfied by ${finalCount} displayed card(s) — no violation`);
      } else if (forcedSearchAllowed({ ctx, text: fullResponseText })) {
        recordTurnInvariantViolation("search_required_not_attempted", { workflow });
      } else {
        console.log(`[chat] turn-plan(${workflow}): search downgraded — required but no concrete basis to search (no violation)`);
      }
    }
    // multi_recommendation TEXT/CARD ALIGNMENT: never promise both shoes and
    // orthotics while showing only one category.
    if (workflow === "multi_recommendation" &&
        multiRecoTextCardMismatch({ text: fullResponseText, cards: finalProductCards })) {
      recordTurnInvariantViolation("multi_reco_text_card_mismatch", { final: finalCount });
    }
    // BROAD GENDER BROWSE: a broad "men's options" ask must end with gender-correct
    // cards from the deterministic gender-only search — never zero cards from a
    // stale-category search (live trace 2026-06-30). Zero cards here means the
    // deterministic pin didn't fire / the gender-only search came back empty.
    if (workflow === "browse" && isBroadGenderReset(ctx?.latestUserMessage || "") && finalCount === 0) {
      recordTurnInvariantViolation("broad_gender_zero_cards", { workflow, gender: ctx?.turnPlan?.gender || "-" });
    }
    // SUPPORT / HANDOFF / POLICY card leak: a policy_account / customer_service /
    // sizing_help turn answers from knowledge and must show NO product cards. Any
    // surviving card is a leak (live trace 2026-06-30: teacher-verification →
    // wedge cards). The deterministic suppression above already drops them; this
    // fires + repairs as the backstop if a card reached finalProductCards anyway.
    if (workflowSuppressesCards(workflow) && finalCount > 0) {
      recordTurnInvariantViolation("support_handoff_cards_leak", { workflow, final: finalCount });
      // policy/FAQ/account/knowledge turns must never show product cards.
      if (isKnowledgeWorkflow(workflow) || isPrivateHandoffWorkflow(workflow)) {
        recordTurnInvariantViolation("policy_cards_leak", { workflow, final: finalCount });
      }
      finalProductCards = [];
    }
    // PRODUCT SPEC answered as availability: a product_spec turn ("what heel
    // heights do your wedges come in?") whose text leaked stock wording ("Yes —
    // all three are available in that.") instead of answering the attribute.
    if (workflow === "product_spec" &&
        specQuestionAnsweredAsAvailability({ message: ctx?.latestUserMessage || "", text: fullResponseText })) {
      recordTurnInvariantViolation("spec_question_answered_as_availability", { workflow });
    }
    // INVARIANT (audit #6): every SHOWN card must be in the evidence pool. The
    // scorer picks FROM the pool, so a scorer-owned card outside it is a leak
    // (injection or cleanup-resurrection). Deterministic owners (availability/
    // comparison/evidence-plan/prior-evidence) are authoritative by construction
    // — they have their own count/owner/family invariants above — so we only
    // assert membership (and repair) on scorer-owned turns to avoid dropping a
    // legitimately-pinned card. REPAIR: drop the stray card rather than ship a
    // product we can't ground.
    if (cardOwner === "scorer" && finalCount > 0) {
      const stray = cardsNotInEvidencePool({
        finalCards: finalProductCards,
        evidencePool: Array.from(allProductPool.values()),
      });
      if (stray.length > 0) {
        const strayKeys = new Set(stray.map((c) => c?.handle || c?.title));
        recordTurnInvariantViolation("card_not_in_evidence_pool", {
          count: stray.length, cards: stray.map((c) => c?.handle || c?.title), repaired: "dropped",
        });
        finalProductCards = finalProductCards.filter((c) => !strayKeys.has(c?.handle || c?.title));
      }
    }
  }

  // DENIAL-WITH-PRODUCTS positive rewrite. When cards ARE shown, the reply must
  // not read as "I couldn't find" / "I'm not seeing" unless those cards are
  // explicitly framed as alternatives. The contract below only WARNS; here we
  // deterministically rewrite the contradiction to positive framing on the live
  // path (repairProductResponseText bails under LLM_OWNS_ALL_TURNS). Honest
  // cards-shown denials — partial availability verdicts, prior-evidence
  // closest-match broadens, terminal deterministic owners, and explicit
  // alternatives framing — are exempt and left untouched.
  {
    const denialRewrite = rewriteDenialWithProducts({
      text: fullResponseText,
      products: finalProductCards,
      cardOwner: resolvedCardOwner,
      answerOwner,
      availabilityResult: availabilityVerdictResult,
      availabilityReason: availabilityVerdictReason,
    });
    if (denialRewrite.changed) {
      console.log(
        `[denial-with-products] ${ctx.shop} rewrote contradictory denial → positive ` +
          `(cards=${finalProductCards.length}, owner=${resolvedCardOwner || answerOwner || "scorer"}, reason=${denialRewrite.reason})`,
      );
      fullResponseText = denialRewrite.text;
    }
  }

  const turnResult = createTurnResult({
    text: fullResponseText,
    products: finalProductCards,
    links: outboundLinks,
    flags: {
      productSearchAttempted,
      recommenderInvoked: recommenderInvokedThisTurn,
      hasSupportCTA: !!supportCTA,
      hasGenericCTA: !!genericCTA,
      hasKlaviyoForm,
    },
    ctx,
    diagnostics: {
      model,
      toolCallCount,
      searchAttempted: productSearchAttempted,
    },
  });
  const turnWarnings = validateTurnResult({
    ...turnResult,
    // A partial availability verdict (width/size not in options) shown WITH the
    // product card is a valid honest answer, not a denial — exempt it from
    // denial_with_products so it doesn't burn retries (#4, live QA 2026-06-30).
    availabilityResult: availabilityVerdictResult,
    availabilityReason: availabilityVerdictReason,
    // Lets the contract exempt prior-evidence closest-match cards from
    // denial_with_products and flag unsupported compatibility claims.
    workflow: ctx?.turnPlan?.workflow,
    cardOwner: resolvedCardOwner,
  });
  if (turnWarnings.length > 0) {
    console.log(
      `[turn-result] ${ctx.shop} warnings=` +
        turnWarnings.map((w) => w.code).join(","),
    );
  }

  return {
    totalUsage,
    toolCallCount,
    model,
    fullResponseText,
    productSearchAttempted,
    recommenderInvokedThisTurn,
    turnResult,
    turnWarnings,
    qualitySignals,
    // EVERY product the model received from tool calls this turn,
    // BEFORE display guards/filters ran. The grounding validator must
    // check claims against this — the model's actual evidence — not
    // against turnResult.products (the post-guard display set). Live
    // trace 2026-06-10: the definition-question guard wiped 6 valid
    // Reagan cards from the display pool, the validator then saw the
    // model's correct "**Reagan Ankle Boot**" answer against an empty
    // pool and burned 3 retries (~35s) on an answer that was grounded
    // all along.
    evidencePool: Array.from(allProductPool.values()),
    // Card ownership for this turn (availability-truth | comparison |
    // evidence-plan | scorer | none). The grounding runner carries this + the
    // final cards into a rewrite-only retry so a comparison/evidence/availability
    // turn keeps the SAME cards + owner and the scorer never takes over. For
    // evidence-plan it also drives the deterministic-fallback path.
    cardOwner: resolvedCardOwner,
    evidenceFallbackText,
    // Availability Truth owns BOTH the cards and the deterministic answer text
    // for an availability turn (buildAvailabilityAnswer). Surfaced so the
    // grounding-retry loop treats it as TERMINAL — a partial verdict like
    // width_not_in_options is a correct final answer, never a retry (live trace
    // 2026-06-30: Savannah 7-wide UNKNOWN/width_not_in_options burned 3 attempts).
    answerOwner,
    availabilityVerdictReason,
    availabilityVerdictResult,
  };
}

export const loader = async () => {
  return Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });
};

export const action = async ({ request }) => {
  try {
    // Two front doors, one engine. The storefront widget arrives through
    // the Shopify app proxy (HMAC query signature); the admin home page's
    // test chat arrives from the embedded admin with an App Bridge session
    // token in the Authorization header. Both run the exact same handler —
    // same prompt, same tools, same grounding validator.
    const authHeader = request.headers.get("authorization") || "";
    let shop;
    let sessionAccessToken;
    // `internal` flags admin-driven test chats so the shared handler
    // skips analytics recording and plan/daily-cap counting — merchant
    // testing must never pollute their own usage numbers or burn quota.
    let internal = false;
    if (authHeader.startsWith("Bearer ")) {
      const { session } = await authenticate.admin(request);
      shop = session.shop;
      sessionAccessToken = session.accessToken;
      internal = true;
    } else {
      const { session } = await authenticate.public.appProxy(request);
      if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
      shop = session.shop;
      sessionAccessToken = session.accessToken;
    }
    return await handleChatPost({ shop, sessionAccessToken, request, internal });
  } catch (e) {
    // authenticate.admin signals auth failures by throwing Responses —
    // pass those through to the framework untouched.
    if (e instanceof Response) throw e;
    // Server-side log keeps the detail; the storefront only ever sees the
    // friendly message. Leaking e.message to the public widget can expose
    // upstream API errors, internal paths, or library stack hints.
    console.error("[chat] error:", e);
    return Response.json(
      {
        error: "action_failed",
        message: "I'm having trouble right now. Please try again in a moment.",
      },
      { status: 500 },
    );
  }
};

// Shared chat handler — everything after authentication. Module-private
// on purpose: exporting it would put a non-route export on this route
// file and drag server modules into the client bundle. Both front doors
// in the action above funnel here.
async function handleChatPost({ shop, sessionAccessToken, request, internal = false }) {
    const rate = checkIpShopRate(shop, clientIp(request));
    if (!rate.ok) {
      return Response.json(
        { error: "rate_limited", retryAfter: rate.retryAfter },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter) } },
      );
    }

    const config = await getShopConfig(shop);
    if (!config.anthropicApiKey) {
      return Response.json(
        { error: "AI engine API key not configured. Set it in the app admin under Settings." },
        { status: 503 },
      );
    }

    const quota = internal ? { ok: true } : await canSendMessage(shop);
    if (!quota.ok) {
      return Response.json(
        {
          error: "plan_limit_reached",
          message: `This store reached its ${quota.limit.toLocaleString()} conversations for the month. Upgrade the plan in the SEoS Assistant admin to keep helping customers.`,
          plan: quota.plan.id,
          used: quota.used,
          limit: quota.limit,
        },
        { status: 402 },
      );
    }

    // Optional merchant-defined daily spending guardrail. When enabled, the
    // chat endpoint stops accepting new conversations once the configured
    // count is reached for the UTC day. Counts come from ChatUsage so the
    // limit is enforced consistently across multiple server instances.
    if (!internal && config.dailyCapEnabled && config.dailyCapMessages > 0) {
      const todayCount = await getTodayMessageCount(shop);
      if (todayCount >= config.dailyCapMessages) {
        return Response.json(
          {
            error: "daily_cap_reached",
            message:
              "The shop's daily AI assistant limit has been reached. The assistant will be available again tomorrow.",
            limit: config.dailyCapMessages,
            used: todayCount,
          },
          { status: 429 },
        );
      }
    }

    const body = await request.json();
    if (!body?.message) {
      return Response.json({ error: "message is required" }, { status: 400 });
    }

    // Input length cap. Pathologically long messages (pastes of
    // entire reviews, complaints, articles) push past Anthropic's
    // context window once added to the 60-65K char system prompt +
    // RAG chunks + history, and the request fails with a generic
    // "I'm having trouble" widget error. Real customer questions
    // rarely exceed 500 chars; capping at 2000 leaves plenty of
    // room for legitimate long-form descriptions while protecting
    // every downstream engine from input-size failures. Truncates
    // the END (keeping the START) since the customer's actual
    // intent is usually in the first sentence or two of a long
    // paste.
    const MAX_MESSAGE_CHARS = 2000;
    if (typeof body.message === "string" && body.message.length > MAX_MESSAGE_CHARS) {
      console.log(
        `[chat] input cap: message len=${body.message.length} truncated to ${MAX_MESSAGE_CHARS}`,
      );
      body.message = body.message.slice(0, MAX_MESSAGE_CHARS);
    }

    const priorProductCards = extractPriorProductCards(body.history);
    const allPriorProductCards = extractAllPriorProductCards(body.history);
    const llmNamedAnchors = extractLLMNamedAnchors(body.history);
    const history = sanitizeHistory(body.history);
    const messages = [...history, { role: "user", content: String(body.message) }];

    // Gender-pivot detection. detectGenderFromHistory walks the entire
    // conversation; if the customer clicked the Men's chip in turn 1
    // and now says "oh wait this is for my mom" in turn 5, the prior
    // chip answer pollutes the prompt's Established Answers block and
    // the AI keeps recommending men's products. Re-run gender
    // detection on JUST the latest user message — if it surfaces a
    // clear pivot signal, that overrides the historical session
    // gender. Gated on relationship words / explicit gender mentions
    // only (no bare pronouns) so a stray "his cousin asked me about
    // this" doesn't flip the entire conversation.
    const PIVOT_RE = /\b(men|mens|men['’]?s|women|womens|women['’]?s|male|female|mom|mother|wife|girlfriend|sister|daughter|grandma|grandmother|aunt|niece|dad|father|husband|boyfriend|brother|son|grandpa|grandfather|uncle|nephew|lady|ladies|guy|dude|girl|girls|boy|boys|kid|kids|children)\b/i;
    const latestUserMessage = String(body.message || "");
    // Rhetorical-question guard. Customer said "do you think my dad
    // is a women?" — sarcastic, accusing the bot of mis-gendering
    // their dad. detectLatestGender is positional and would return
    // "women" (the last gender word in the sentence), flipping the
    // gender lock from Men to Women — exactly the opposite of the
    // customer's intent. Skip pivot when the message is a rhetorical
    // accusation. Patterns: "do you think / are you assuming / are
    // you saying X is Y", "you think X is Y", "did i say X is Y".
    const RHETORICAL_RE = /\b(?:do you (?:really )?think|are you (?:assuming|saying|kidding|implying|telling me)|did i (?:say|tell you)|why (?:do|would|are) you (?:think|assume|recommend))\b/i;
    const isRhetorical = RHETORICAL_RE.test(latestUserMessage);
    const historicalSessionGender = detectGenderFromHistory(messages);
    const latestPivotedGender =
      (PIVOT_RE.test(latestUserMessage) && !isRhetorical)
        ? detectLatestGender(latestUserMessage)
        : null;
    if (isRhetorical && PIVOT_RE.test(latestUserMessage)) {
      console.log(
        `[chat] gender-pivot suppressed: message is rhetorical/accusing ` +
          `("${latestUserMessage.slice(0, 60)}")`,
      );
    }
    const earlySessionMemory = buildSessionMemory({ messages, classifiedIntent: null, resolverState: null });
    const latestTurnDroppedGender =
      earlySessionMemory?.latestTurnIntent?.staleKeysToDrop?.includes("gender") === true;
    // Pivot wins. When the latest message has a clear pivot signal,
    // that's the source of truth for this turn forward — catalog
    // scoping, ctx.sessionGender, search filters, all flow from this
    // single value. Without the pivot, fall back to the historical
    // detection (chip clicks + earlier mentions).
    //
    // `let`, not `const`: this is the EARLY (pre-classifier) estimate
    // used for catalog chip scoping. After the LLM classifier runs it
    // is reconciled via reconcileSessionGender so the authoritative
    // adult gender (classifier-owned) drives the search / gender-lock.
    let sessionGender = latestPivotedGender || (latestTurnDroppedGender ? null : historicalSessionGender);
    if (latestPivotedGender && latestPivotedGender !== historicalSessionGender) {
      console.log(
        `[chat] gender-pivot: history=${historicalSessionGender || "-"} → latest=${latestPivotedGender} ` +
          `(triggered by "${latestUserMessage.slice(0, 60)}")`,
      );
    } else if (latestTurnDroppedGender && historicalSessionGender) {
      console.log(
        `[chat] gender-memory: dropped stale sessionGender="${historicalSessionGender}" ` +
          `for latest turn reason=${earlySessionMemory?.latestTurnIntent?.reason || "-"}`,
      );
    }
    const answeredChoices = extractAnsweredChoices(messages);

    // When gender was detected from natural language ("for my dad",
    // "my wife", "I'm a man") rather than from a chip answer, the
    // existing answeredChoices doesn't include it — so the prompt's
    // "Established Answers" block has no gender entry, and the AI
    // ignores the rules-knowledge "gender is locked" intent and asks
    // anyway. Inject a synthetic entry so the AI sees gender as
    // already-answered and skips the gender question.
    //
    // On a real pivot (latestPivotedGender different from history),
    // drop any prior gender chip-answer first so the new gender takes
    // precedence — otherwise an old "Men's" chip click in turn 1
    // sticks and contradicts the new "for my mom" context.
    if (sessionGender) {
      const isPivot = Boolean(latestPivotedGender) && latestPivotedGender !== historicalSessionGender;
      if (isPivot) {
        for (let i = answeredChoices.length - 1; i >= 0; i--) {
          const c = answeredChoices[i];
          if (
            /\b(men|women|gender|him|her|man|woman)\b/i.test(c.question || "") ||
            /\b(men|women|men's|women's)\b/i.test(c.answer || "")
          ) {
            answeredChoices.splice(i, 1);
          }
        }
      }
      const alreadyHas = answeredChoices.some((c) =>
        /\b(men|women|gender|him|her|man|woman)\b/i.test(c.question || "") ||
        /\b(men|women|men's|women's)\b/i.test(c.answer || ""),
      );
      if (isPivot || !alreadyHas) {
        answeredChoices.unshift({
          question: "Are these for men's or women's?",
          answer: sessionGender === "men" ? "Men's" : "Women's",
          rawAnswer: sessionGender === "men" ? "Men's" : "Women's",
          options: ["Men's", "Women's"],
        });
      }
    }

    let [knowledge, attrMappings, catalogProductTypes, allCatalogCategories, categoryGenderMap, categoryAttributeCoverage, activeCampaigns, claimConfig, catalogFacetIndex] = await Promise.all([
      getKnowledgeFilesWithContent(shop),
      getAttributeMappings(shop),
      getCatalogCategories(shop, { gender: sessionGender }),
      getAllCatalogCategories(shop),
      getCategoryGenderAvailability(shop),
      getCategoryAttributeCoverage(shop),
      getActiveCampaigns(shop),
      // Merchant-data-driven claim rules / category groups / color
      // families. Loaded once per request and parked on ctx so every
      // emit path (extractProductCards, the Product Turn Engine, the
      // composer) sees the same merchant config. First request per
      // shop auto-seeds DEFAULT_SEED_* rows; subsequent requests are
      // a cache hit. Dynamic import keeps RR's client bundler from
      // trying to follow the prisma-touching module chain into the
      // client build.
      import("../lib/merchant-claim-config.server")
        .then((m) => m.getMerchantClaimConfig(shop))
        .catch((err) => {
          console.warn(`[chat] claim-config load failed for ${shop}: ${err?.message || err}`);
          return null;
        }),
      getCatalogFacetIndex(shop).catch((err) => {
        console.warn(`[chat] catalog-facet-index load failed for ${shop}: ${err?.message || err}`);
        return null;
      }),
    ]);

    // Aetrex-specific suppressed categories. These exist in the live
    // Shopify catalog (3 sock SKUs, 1 gift-card SKU at last sync) but
    // the merchant has confirmed they're not actively sold or
    // promoted. Strip them from BOTH the gender-scoped allow-list
    // (catalogProductTypes — used for chips) and the full-catalog
    // list (allCatalogCategories — used by STORE FACTS). Without
    // this strip, the AI suggested "<<Socks>>" and "<<Gift Card>>"
    // as Mother's Day gift chips when the customer asked for non-
    // shoe non-orthotic options.
    //
    // Long-term: this should become a per-merchant admin config
    // ("hidden categories" list). For now, hardcoded matches the
    // Aetrex-specific direction the project is taking.
    const SUPPRESSED_CATEGORIES = new Set(["socks", "gift card"]);
    const suppressFn = (cats) => Array.isArray(cats)
      ? cats.filter((c) => !SUPPRESSED_CATEGORIES.has(String(c || "").toLowerCase().trim()))
      : cats;
    const beforeScopedCount = catalogProductTypes.length;
    const beforeFullCount = allCatalogCategories.length;
    catalogProductTypes = suppressFn(catalogProductTypes);
    allCatalogCategories = suppressFn(allCatalogCategories);
    if (
      catalogProductTypes.length !== beforeScopedCount ||
      allCatalogCategories.length !== beforeFullCount
    ) {
      console.log(
        `[chat] ${shop} suppressed categories from allow-list: ` +
          `[${[...SUPPRESSED_CATEGORIES].join(", ")}] ` +
          `(scoped: ${beforeScopedCount}→${catalogProductTypes.length}, ` +
          `full: ${beforeFullCount}→${allCatalogCategories.length})`,
      );
    }

    // Merchant-configured category groups: keep a server-side product-intent
    // group from the conversation, then narrow the prompt/catalog surface to
    // that group's categories. This is fully data-driven — no hardcoded store
    // vocabulary anywhere.
    //
    // - Zero groups configured: no filter applied (full allow-list goes
    //   through). Configure groups in Rules & Knowledge to enable.
    // - Multiple groups match in the same user message (e.g. "orthotic shoes" hits both Footwear and
    //   Orthotics): no filter applied — the AI sees the full allow-list
    //   and resolves the ambiguity itself. Safer than picking wrong.
    // - Short follow-up answers like "Men's" or "Running Shoes" keep the
    //   prior product goal when the previous assistant turn was asking a
    //   contextual question about another group. That preserves "orthotic"
    //   as the thing to buy while using "running shoes" as fit context.
    let merchantGroups = [];
    try { merchantGroups = JSON.parse(config.categoryGroups || "[]"); } catch { /* */ }

    let groupFilterApplied = "";
    const categoryIntent = analyzeCategoryIntent(messages, merchantGroups);
    const catalogScopeCategories =
      categoryIntent.activeGroup && !categoryIntent.ambiguous && Array.isArray(categoryIntent.activeGroup.categories)
        ? categoryIntent.activeGroup.categories
        : [];

    // Active-group narrowing is used to prefer chips and bias
    // search filters, NOT to shrink the prompt's ALLOW-LIST. When
    // the customer asks "do you have closed-toe option with
    // orthotic footbed", the active-group detector may pick
    // Orthotics, but the women's catalog still has 14 categories
    // — narrowing the ALLOW-LIST to "Orthotics" alone makes the AI
    // tell the customer the catalog only carries orthotics.
    //
    // Keep the gender-filtered catalogProductTypes as the source
    // of truth for the ALLOW-LIST. Store the narrowed result
    // separately so chip-preference logic can still use it via
    // `merchantGroups` + active-group context — but the AI's
    // category awareness stays correct.
    if (Array.isArray(merchantGroups) && merchantGroups.length > 0) {
      if (categoryIntent.activeGroup && !categoryIntent.ambiguous) {
        const g = categoryIntent.activeGroup;
        const allowed = new Set((g.categories || []).map((c) => String(c).toLowerCase()));
        const filtered = catalogProductTypes.filter((c) => allowed.has(String(c).toLowerCase()));
        if (filtered.length >= 1) {
          // Track which group narrowed for downstream search filtering
          // and observability — but do NOT overwrite catalogProductTypes
          // (the prompt's ALLOW-LIST). The active group is advisory
          // for chip selection, not a denial of other categories.
          groupFilterApplied = g.name;
        }
      }
    }

    // Same idea as the synthetic gender injection above: if the category
    // intent locked an active group from history (e.g. user said
    // "orthotics" three turns ago, then answered "Both" for pain), make
    // sure the prompt knows the category is established so the AI doesn't
    // re-ask "what type of product?" after it already committed.
    if (
      categoryIntent.activeGroup &&
      !categoryIntent.ambiguous &&
      categoryIntent.activeGroup.name &&
      !answeredChoices.some((c) =>
        new RegExp(`\\b${categoryIntent.activeGroup.name}\\b`, "i").test(c.answer || "") ||
        /\b(category|product type|what (?:type|kind))\b/i.test(c.question || "")
      )
    ) {
      answeredChoices.unshift({
        question: "What type of product are you looking for?",
        answer: categoryIntent.activeGroup.name,
        rawAnswer: categoryIntent.activeGroup.name,
        options: [categoryIntent.activeGroup.name],
      });
    }

    console.log(`[chat] ${shop} gender=${sessionGender || "any"} scoped-categories=${catalogProductTypes.length} full-catalog-categories=${allCatalogCategories.length}${groupFilterApplied ? ` group=${groupFilterApplied}` : ""}${categoryIntent.contextGroup ? ` contextGroup=${categoryIntent.contextGroup.name}` : ""}${categoryIntent.ambiguous ? " group=ambiguous" : ""}`);
    const attributeNames = attrMappings.map((m) => m.attribute);

    let categoryExclusions = [];
    try { categoryExclusions = JSON.parse(config.categoryExclusions || "[]"); } catch { /* */ }
    let querySynonyms = [];
    try { querySynonyms = JSON.parse(config.querySynonyms || "[]"); } catch { /* */ }
    let similarMatchAttributes = [];
    try {
      const raw = JSON.parse(config.similarMatchAttributes || "[]");
      similarMatchAttributes = Array.isArray(raw)
        ? raw.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean)
        : [];
    } catch { /* */ }
    let collectionLinks = [];
    let ctaOverrides = [];
    try {
      const raw = JSON.parse(config.ctaOverrides || "[]");
      ctaOverrides = Array.isArray(raw)
        ? raw
            .map((r) => ({
              modifier: String(r?.modifier || "").trim().toLowerCase(),
              gender: String(r?.gender || "").trim().toLowerCase(),
              category: String(r?.category || "").trim().toLowerCase(),
              url: String(r?.url || "").trim(),
              label: String(r?.label || "").trim(),
            }))
            .filter((r) => r.url && (r.modifier || r.gender || r.category))
        : [];
    } catch { /* */ }
    try {
      const raw = JSON.parse(config.collectionLinks || "[]");
      collectionLinks = Array.isArray(raw)
        ? raw
            .map((r) => ({
              category: String(r?.category || "").trim().toLowerCase(),
              gender: String(r?.gender || "").trim().toLowerCase(),
              url: String(r?.url || "").trim(),
              label: String(r?.label || r?.category || "").trim(),
            }))
            .filter((r) => r.category && r.url)
        : [];
    } catch { /* */ }
    let fitPredictorConfig = {};
    try {
      const raw = JSON.parse(config.fitPredictorConfig || "{}");
      if (raw && typeof raw === "object") fitPredictorConfig = raw;
    } catch { /* */ }

    // Logged-in customer ID is HMAC-verified by Shopify on app proxy requests.
    // This is the only trustworthy customer identifier — we NEVER use any
    // customer_id sent in the POST body from the widget JS.
    const url = new URL(request.url);
    const loggedInCustomerId = url.searchParams.get("logged_in_customer_id") || null;

    // sessionAccessToken from app proxy may be an online/proxy token; for
    // Admin API calls we need the offline token. Fall back to the Session
    // table if the proxy session's token is missing.
    let accessToken = sessionAccessToken;
    if (!accessToken) {
      const offline = await prisma.session.findFirst({
        where: { shop: shop, isOnline: false },
        orderBy: { expires: "desc" },
      });
      accessToken = offline?.accessToken || null;
    }

    let customerContext = null;
    if (loggedInCustomerId && config.vipModeEnabled === true && accessToken) {
      customerContext = await fetchCustomerContext({
        shop: shop,
        accessToken,
        customerId: loggedInCustomerId,
        orderLimit: 5,
      });

      // Enrich with Klaviyo segments + Yotpo loyalty in parallel. Both are
      // opt-in (require a configured API key) and fail silently — enrichment
      // must never block a chat response. Email is used only server-side for
      // the lookup and is never placed in the system prompt.
      if (customerContext?._email) {
        const [klaviyo, loyalty] = await Promise.all([
          config.klaviyoPrivateKey
            ? fetchKlaviyoEnrichment({ privateKey: config.klaviyoPrivateKey, email: customerContext._email })
            : Promise.resolve(null),
          config.yotpoLoyaltyApiKey
            ? fetchYotpoLoyalty({ apiKey: config.yotpoLoyaltyApiKey, guid: config.yotpoLoyaltyGuid, email: customerContext._email })
            : Promise.resolve(null),
        ]);
        if (klaviyo) customerContext.klaviyo = klaviyo;
        if (loyalty) customerContext.loyalty = loyalty;
      }
    }

    // RAG retrieval (batch 2c). When the shop has opted in via
    // knowledgeRagEnabled and a query string is available, retrieve
    // top-K most-relevant KnowledgeChunk rows for the customer's
    // latest message and pass them to buildSystemPrompt INSTEAD of
    // the full knowledge dump. Failures (no provider, no chunks
    // embedded yet, query empty) return [] and the prompt builder
    // falls back to the legacy full-dump path automatically.
    // Per-request embedding usage accumulator. Query-time embedding
    // calls (RAG retrieval below + semantic product search inside the
    // search_products tool) add their token counts here so
    // recordChatUsage can fold the semantic-search spend into the same
    // ChatUsage row as the Anthropic tokens. Index-time embedding
    // (product sync, chunk backfill) is intentionally NOT tracked here
    // — that's a one-time indexing cost, not per-chat.
    const embeddingUsage = { tokens: 0, calls: 0, provider: "" };
    const addEmbeddingUsage = (u) => {
      embeddingUsage.tokens += Number(u?.totalTokens) || 0;
      embeddingUsage.calls += 1;
      if (u?.provider) embeddingUsage.provider = u.provider;
    };

    let retrievedChunks = null;
    if (config.knowledgeRagEnabled === true) {
      const ragQuery = String(body.message || "").trim();
      if (ragQuery) {
        try {
          retrievedChunks = await retrieveRelevantChunks(prisma, {
            shop: shop,
            query: ragQuery,
            config,
            limit: 5,
            onEmbeddingUsage: addEmbeddingUsage,
          });
          const topChunk = Array.isArray(retrievedChunks) && retrievedChunks.length > 0 ? retrievedChunks[0] : null;
          console.log(
            `[rag] attempted=true hits=${retrievedChunks?.length || 0}` +
            (topChunk ? ` topCategory=${topChunk.fileType || "-"} topScore=${Number(topChunk.similarity).toFixed(2)}` : "") +
            ` query="${ragQuery.slice(0, 60)}"`,
          );
        } catch (err) {
          console.error("[rag] retrieval failed, falling back to full dump:", err?.message || err);
          retrievedChunks = null;
        }
      }
    } else {
      console.log(`[rag] attempted=false reason=${config.knowledgeRagEnabled === true ? "empty_query" : "rag_disabled"}`);
    }

    // Focus-product anchor. When the customer asks a fact/sizing
    // question about a product already on screen ("what size should I
    // choose", "does it come in black", "how much is it"), bind the
    // answer to THAT product so the model doesn't re-search and surface
    // a different one (prod trace 2026-06-15: "what size" after a
    // recommendation returned a different orthotic every turn). Only
    // anchor when the target is unambiguous: the latest text names a
    // shown card, or exactly one card is on screen.
    let focusProduct = null;
    if (Array.isArray(priorProductCards) && priorProductCards.length > 0) {
      const convGoal = detectConversationGoal(messages);
      const isFactFollowup =
        (convGoal && ANCHOR_GOALS.has(convGoal.type)) ||
        isSizeWidthFactFollowUp(latestUserMessage) ||
        isColorFactFollowUp(latestUserMessage) ||
        isDirectProductFactQuestion(latestUserMessage);
      // ORDINAL / SELECTION reference ("the second one", "second pair", "I like
      // the first") binds to that card regardless of goal — selection and cart
      // turns need the focus too (live trace 2026-06-30: "I like the second one"
      // shipped with no card). Resolve by ordinal, then by name, then the sole
      // card for a bare deictic ("it"/"this one").
      const ordinal = resolveOrdinalCard(latestUserMessage, priorProductCards);
      const named = resolveFocusedCardByName(latestUserMessage, priorProductCards);
      if (ordinal) {
        focusProduct = ordinal;
        console.log(`[chat] focus-product anchor (ordinal): "${focusProduct.title}"`);
      } else if (isFactFollowup) {
        focusProduct = named || (priorProductCards.length === 1 ? priorProductCards[0] : null);
        if (focusProduct) {
          console.log(`[chat] focus-product anchor: "${focusProduct.title}" (goal=${convGoal?.type || "fact-followup"})`);
        }
      } else if (named) {
        focusProduct = named;
        console.log(`[chat] focus-product anchor (named selection): "${focusProduct.title}"`);
      } else if (priorProductCards.length === 1 && /\b(this|that|it|the)\s*(one|pair|product)?\b/i.test(latestUserMessage)) {
        focusProduct = priorProductCards[0];
        console.log(`[chat] focus-product anchor (sole card + deictic): "${focusProduct.title}"`);
      }
    }

    const promptBuild = buildSystemPrompt({
      config,
      knowledge,
      retrievedChunks,
      shop: shop,
      focusProduct,
      attributeNames,
      categoryExclusions,
      querySynonyms,
      customerContext,
      fitPredictorEnabled: config.fitPredictorEnabled === true,
      catalogProductTypes,
      // Full catalog category list — independent of the active-group
      // scope. Pinned in the prompt so the AI never claims a real
      // category is absent just because the current turn is scoped
      // narrowly (e.g. activeGroup=Orthotics shouldn't make the AI
      // say "we don't sell shoes").
      fullCatalogProductTypes: allCatalogCategories,
      scopedGender: sessionGender,
      answeredChoices,
      categoryGenderMap,
      activeCampaigns,
      merchantGroups,
    }, { withCacheInfo: true });
    let systemPrompt = promptBuild.text;
    // Index where the stable (cacheable) prefix ends. Appends below
    // (`systemPrompt += ...`) land in the volatile suffix and never
    // invalidate the cached prefix.
    const promptStableLength = promptBuild.stableLength || 0;
    const kidsCoverage = buildKidsCoveragePrompt({ sessionGender, catalogProductTypes });
    if (kidsCoverage.prompt) {
      console.log(
        `[chat] ${shop} kids-coverage: no kids footwear in catalog ` +
        `(scoped=${catalogProductTypes.join("|") || "none"}; alternatives=${kidsCoverage.diagnostics.availableNonFootwear?.join("|") || "none"}); injecting honesty note`,
      );
      systemPrompt += kidsCoverage.prompt;
    }
    if (isCompoundPolicyProductQuestion(body.message)) {
      systemPrompt +=
        "\n\n=== Compound request handling (turn-scoped) ===\n" +
        "The latest customer message contains both a support/policy question and a product-shopping request. " +
        "Answer every distinct ask. Briefly answer the support/policy part, and also use search_products for the product-shopping part so product cards can render. " +
        "Do not treat the whole turn as support-only, and do not drop the product request.\n";
    }

    // Central TurnPlan — the single front-of-turn brain. Computed INSIDE the
    // stream callback (below) once the classifier + reconciled gender are
    // known, then stored on ctx so search, validators, emit-finalize and the
    // card/clarification gates all read the same plan. Declared here so the
    // closure variable + ctx field exist before the stream starts.
    let turnPlan = null;

    const model = chooseModel(config, String(body.message), history);

    const conversationText = messages.map((m) => typeof m.content === "string" ? m.content : "").join(" ");
    const userText = messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : "").join(" ");

    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const ctx = {
      shop: shop,
      // Per-request embedding (semantic search) usage accumulator —
      // mutated by query-time embedText calls, read by recordChatUsage.
      embeddingUsage,
      deduplicateColors: config.deduplicateColors,
      sessionGender,
      categoryExclusions,
      querySynonyms,
      similarMatchAttributes,
      collectionLinks,
      storefrontSearchUrlPattern: String(config.storefrontSearchUrlPattern || ""),
      ctaOverrides,
      fitPredictorConfig,
      fitPredictorEnabled: config.fitPredictorEnabled === true,
      conversationText,
      userText,
      yotpoApiKey: config.yotpoApiKey || "",
      aftershipApiKey: config.aftershipApiKey || "",
      supportUrl: body.support_url || config.supportUrl || "",
      supportLabel: body.support_label || config.supportLabel || "",
      // RAG result for THIS turn (null=not run, []=ran no hits, [..]=hits). The
      // answer-source contract in the emit/finalize stage reads this to decide
      // whether a knowledge turn answers from RAG or hands off.
      retrievedChunks,
      knowledgeRagEnabled: config.knowledgeRagEnabled === true,
      // Full knowledge corpus (joined) for the answer-source contract's lexical
      // fallback: a knowledge turn must try RAG AND a keyword scan of this text
      // before handing off to support.
      knowledgeText: Array.isArray(knowledge) ? knowledge.map((k) => String(k?.content || "")).join("\n\n") : "",
      accessToken,
      loggedInCustomerId,
      vipModeEnabled: config.vipModeEnabled === true,
      // Showcase layout supports a horizontal scroll-snap row of up to
      // 10 cards. Legacy horizontal layout stays capped at 3 since
      // 4+ stacked cards crowd the chat panel vertically.
      productCardCap: config.productCardStyle === "showcase" ? 10 : 3,
      trackingPageUrl: config.trackingPageUrl || "",
      returnsPageUrl: config.returnsPageUrl || "",
      catalogCategories: catalogProductTypes,
      activeCategoryGroup: categoryIntent.activeGroup,
      contextCategoryGroup: categoryIntent.contextGroup,
      categoryIntentAmbiguous: Boolean(categoryIntent.ambiguous),
      merchantGroups,
      shopConfig: config,
      fullCatalogCategories: allCatalogCategories,
      categoryGenderMap,
      catalogFacetIndex,
      catalogScopeCategories,
      // Merchant-data-driven claim rules / category groups / color
      // families. Parked on ctx so extractProductCards, the Product
      // Turn Engine, and the composer all see the same merchant
      // config without re-querying. May be null if the DB call
      // failed; downstream paths degrade to scan-only.
      claimConfig,
      latestUserMessage: String(body.message || ""),
      priorProductCards,
      allPriorProductCards,
      llmNamedAnchors,
      debugChatEvents: body?.debug === true,
      messages,
      // Set below, inside the stream callback, once the classifier and
      // reconciled gender are known. Read by search, validators, the
      // emit-finalize card gate, and the clarification gate.
      turnPlan: null,
    };
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // CS-team cheat code: if the customer's exact message
          // matches the merchant-configured phrase, skip the AI and
          // emit a deterministic dump of every active campaign.
          //
          // Inner try/catch so any failure here (Prisma, stream
          // controller, formatter) just falls through to the normal
          // AI flow instead of returning the generic "having trouble"
          // error to the customer. The actual error still logs.
          try {
            const cheatCode = String(config.campaignCheatCode || "").trim().toLowerCase();
            const userMessageNorm = String(body?.message || "").trim().toLowerCase();
            if (cheatCode && userMessageNorm === cheatCode) {
              const dump = formatCampaignsForCS(activeCampaigns, new Date());
              controller.enqueue(encoder.encode(sseChunk({ type: "text", text: dump })));
              controller.enqueue(encoder.encode(sseChunk({ type: "products", products: [] })));
              controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
              // Don't call controller.close() — the start() callback
              // returning is what the React Router stream wrapper uses
              // as the close signal. Calling close here can race with
              // the wrapper's own teardown.
              logTurnInvariant({ answerOwner: "cheat-code", cardOwner: "none", finalCards: 0, path: "cheat-code" });
              return;
            }
          } catch (cheatErr) {
            console.error("[chat] cheat-code path failed, falling back to AI:", cheatErr?.stack || cheatErr?.message || cheatErr);
          }

          const activeTools = [...TOOLS];
          if (loggedInCustomerId && config.vipModeEnabled === true && accessToken) {
            activeTools.push(CUSTOMER_ORDERS_TOOL);
          }
          if (config.fitPredictorEnabled === true) {
            activeTools.push(FIT_PREDICTOR_TOOL);
          }
          // Smart Recommender tools — one per merchant-defined intent
          // (orthotic, mattress, pillow, etc.). The LLM decides when
          // to call them; we only register them. When none exist or
          // the master toggle is off, this contributes zero tools and
          // the chat is unchanged.
          let recommenderTrees = [];
          try {
            const built = await buildRecommenderTools(shop, {
              decisionTreeEnabled: config.decisionTreeEnabled === true,
            });
            if (built.tools.length > 0) {
              activeTools.push(...built.tools);
              recommenderTrees = built.trees;
              ctx.recommenderTrees = built.trees;
              console.log(
                `[recommender] registered ${built.tools.length} tool(s) for ${shop}: ` +
                  built.tools.map((t) => t.name).join(", "),
              );
            }
          } catch (recErr) {
            console.error("[recommender] tool registration failed:", recErr?.message || recErr);
          }

          const routerLog = {
            classifier: null,
            resolver: null,
            orthoticGate: null,
            finalPath: null,
          };

          // STAGE 1: classifier (cost-gated).
          // The Haiku orthotic classifier costs ~$0.0015 + 400–700ms
          // per turn. Skip it when the message clearly isn't about
          // orthotics or a foot condition — those turns return all-
          // null attributes anyway. The pre-gate covers vocabulary,
          // foot conditions, recipient ambiguity ("for my son"), and
          // any active orthotic flow signaled by recent assistant
          // turns. False positives are quality-neutral (we just run
          // the classifier unnecessarily); the gate errs inclusive.
          let classifiedIntent = null;
          const orthoticTree = (recommenderTrees || []).find((t) => t?.intent === "orthotic");
          let classifierBypassed = false;
          if (orthoticTree) {
            if (shouldRunOrthoticClassifier({ messages })) {
              try {
                classifiedIntent = await classifyOrthoticTurn({
                  messages,
                  anthropic,
                  shop: shop,
                });
                ctx.classifiedIntent = classifiedIntent;
              } catch (clsErr) {
                console.error("[classifier] threw, falling through:", clsErr?.message || clsErr);
              }
            } else {
              classifierBypassed = true;
            }
          }
          routerLog.classifier = classifiedIntent
            ? `isOrthoticRequest=${!!classifiedIntent.isOrthoticRequest} attrs=${JSON.stringify(classifiedIntent.attributes || {})}`
            : classifierBypassed
              ? "bypassed-by-pregate"
              : "none";

          // Gender authority. The LLM classifier extracts adult gender
          // only when the customer EXPLICITLY stated it, so a confident
          // Men/Women beats the positional regex history scan — which
          // can re-land on a stale earlier mention after a recipient
          // pivot ("a gift for my mom" following an earlier "men's"),
          // the root of the "we don't have men's" dead-end. Reconcile
          // here, after the classifier and before the resolver / agentic
          // loop, so the corrected gender drives the search and the
          // gender-lock (both read ctx.sessionGender). The pre-classifier
          // chip scoping above keeps the early estimate; on a true pivot
          // that only affects which chips render, not search correctness.
          let genderAuthorityFromClassifier = false;
          {
            const reconciledGender = reconcileSessionGender(
              sessionGender,
              classifiedIntent?.attributes?.gender,
              classifiedIntent?.confidence,
            );
            if (reconciledGender !== sessionGender) {
              console.log(
                `[chat] gender-authority: classifier="${classifiedIntent?.attributes?.gender}" ` +
                  `(conf=${classifiedIntent?.confidence}) overrides regex sessionGender=` +
                  `"${sessionGender || "-"}" → "${reconciledGender || "-"}"`,
              );
              sessionGender = reconciledGender;
              ctx.sessionGender = reconciledGender;
              genderAuthorityFromClassifier = true;
            }
          }

          // ── Latest-turn scope (state hygiene) ───────────────────────────
          // Decide whether THIS message is a FOLLOW_UP (deictic / prior-card
          // reference) or a NEW_INDEPENDENT_ASK. On a new independent ask, drop
          // the classifier's inherited category/color/condition that the latest
          // message doesn't itself support — otherwise a fresh "vacation walking"
          // turn answers the prior flat-feet/sneaker/black question. Mutating the
          // shared classifier attrs means planTurn, the over-elicitation guard,
          // the recommender gate, and search all read the SAME scoped facts.
          {
            const priorUserTurns =
              messages.filter((m) => m?.role === "user").length - 1;
            const priorCardCount = Array.isArray(priorProductCards) ? priorProductCards.length : 0;
            const turnScope = classifyTurnScope(latestUserMessage, {
              priorCardCount,
              priorAttributes:
                priorCardCount > 0 || priorUserTurns >= 1
                  ? (ctx.classifiedIntent?.attributes || { _: true })
                  : null,
            });
            ctx.turnScope = turnScope.scope;
            ctx.turnIsFollowUp = turnScope.scope === "follow_up";
            ctx.turnIsShortAmbiguous = isShortAmbiguousReply(latestUserMessage);
            // ANSWERING A PENDING ORTHOTIC SEED QUESTION is a follow-up for
            // attribute scoping — the reply ("hoka sneakers", "sneakers") is the
            // ANSWER to "what kind of shoes?", so the just-classified use-case /
            // condition must NOT be wiped as a fresh ask (which loops the gate).
            const answeringOrthoticSeed = priorTurnWasOrthoticSeedQuestion({ messages, tree: orthoticTree });
            if (ctx.classifiedIntent?.attributes) {
              const before = ctx.classifiedIntent.attributes;
              const scoped = scopeAttributesToTurn(before, latestUserMessage, {
                isFollowUp: ctx.turnIsFollowUp || answeringOrthoticSeed,
              });
              const wiped = Object.keys(scoped).filter(
                (k) => before[k] != null && before[k] !== "" && (scoped[k] == null || scoped[k] === ""),
              );
              ctx.classifiedIntent.attributes = scoped;
              if (wiped.length) {
                console.log(
                  `[turn-scope] ${shop} scope=${turnScope.scope} (${turnScope.reason}) ` +
                  `wiped stale attrs=[${wiped.join(",")}] on a new independent ask`,
                );
              } else if (answeringOrthoticSeed && !ctx.turnIsFollowUp) {
                console.log(`[turn-scope] ${shop} answering pending orthotic seed question — kept classified attrs (no fresh-ask wipe)`);
              }
            }
          }

          // ── Central TurnPlan ────────────────────────────────────────────
          // Now that the classifier ran and gender is reconciled, classify
          // the turn into ONE workflow and store the plan on ctx so search,
          // validators, the emit-finalize card gate and the clarification
          // gate all read the same decision. The compact plan block is
          // injected into the volatile prompt suffix so the model follows it.
          try {
            const clsAttrs = ctx.classifiedIntent?.attributes || {};
            // namedProduct is true ONLY when the LATEST message names a product
            // family (Jillian/Savannah/…), or uses a deictic ("this/it/that
            // one") AND a valid focusProduct is in context. A leftover
            // focusProduct from a PRIOR card must NOT make a fresh
            // condition/use-case turn ("I have PF, need walking sandals")
            // misclassify as named_product_advisory.
            // Named families come from the LATEST message only (generic
            // category/color/condition words are stopwords). A deictic
            // ("this/it/that one") + a focusProduct also counts as named.
            let namedFamilies = [];
            try {
              namedFamilies = await extractCatalogProductFamilies(shop, latestUserMessage);
            } catch { /* family lookup best-effort */ }
            const deicticRef = /\b(this one|that one|these|those|\bit\b|\bthis\b|\bthat\b)\b/i.test(latestUserMessage);
            const deicticFamily = deicticRef && focusProduct
              ? String(focusProduct.title || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).find((t) => t.length >= 4) || null
              : null;
            if (deicticFamily && !namedFamilies.includes(deicticFamily)) namedFamilies = [...namedFamilies, deicticFamily];
            const planNamedProduct = namedFamilies.length > 0;
            // Distinct families among the previously displayed cards. When the
            // last turn showed 2+ families (an evidence-plan trio, a comparison
            // pair), a bare color/size follow-up ("do they come in black?")
            // targets that SET — TurnPlan routes it to prior_evidence_availability
            // so it's remapped per family deterministically (never the scorer).
            const priorCardFamilies = Array.isArray(priorProductCards)
              ? Array.from(new Set(priorProductCards.map((c) => familyOfTitle(c?.title || "")).filter(Boolean)))
              : [];
            turnPlan = planTurn({
              message: latestUserMessage,
              attrs: {
                gender: clsAttrs.gender || sessionGender || undefined,
                condition: clsAttrs.condition || undefined,
                useCase: ctx.classifiedIntent?.isOrthoticRequest ? clsAttrs.useCase : undefined,
              },
              namedProduct: planNamedProduct,
              focusProduct: focusProduct ? (focusProduct.handle || focusProduct.title || true) : null,
              hasPriorCards: Array.isArray(priorProductCards) && priorProductCards.length > 0,
              priorCardFamilies,
              // The bot's last message — lets a bare "yes" inherit the action it
              // just offered ("want similar alternatives?", "check sizes?").
              priorAssistantText: lastAssistantContent(messages) || "",
              primaryGender: "women",
            });
            // The named families this turn must search — the evidence lock
            // uses this so the named product is searched BEFORE alternatives.
            turnPlan.namedFamilies = namedFamilies;
            ctx.turnPlan = turnPlan;
            // Explicit answer-source plan for this turn (requirement #3). Logs
            // which sources the workflow may use BEFORE the answer is produced —
            // if RAG is skipped on a knowledge turn, the log says why.
            {
              const srcM = answerSourceMatrix(turnPlan.workflow);
              const ragHit = Array.isArray(retrievedChunks) && retrievedChunks.length > 0;
              const ragState = !srcM.rag ? "off"
                : retrievedChunks == null ? (ctx.knowledgeRagEnabled ? "unavailable" : "disabled")
                : ragHit ? "hit" : "miss";
              console.log(
                `[source-plan] workflow=${turnPlan.workflow} productSearch=${srcM.productSearch} ` +
                `rag=${ragState} accountTool=${srcM.accountTool} handoff=${srcM.handoff} cards=${srcM.productCards}`,
              );
            }
            // Expose the anchored focus product so the availability-truth flow
            // can inherit family/color on a deictic follow-up ("what about 9?").
            ctx.focusProduct = focusProduct || null;
            const planBlock = buildTurnPlanPromptBlock(turnPlan);
            if (planBlock) {
              systemPrompt += "\n\n" + planBlock + "\n";
              console.log(
                `[chat] turn-plan workflow=${turnPlan.workflow} search=${turnPlan.searchRequired} ` +
                `clarify=${turnPlan.clarificationAllowed} display=${turnPlan.productDisplayPolicy} ` +
                `gender=${turnPlan.gender || "-"} named=${planNamedProduct} families=[${namedFamilies.join(",")}]`,
              );
            }
          } catch (planErr) {
            console.error("[chat] turn-plan failed (non-fatal):", planErr?.message || planErr);
          }

          // Pending orthotic guided-flow state handoff. When an orthotic seed
          // question is pending ("What kind of shoes will the orthotics go
          // in?"), the next turn either CONTINUES the flow (it answers the
          // question — a footwear word like "Hoka sneakers" is the use-case
          // answer, not a category pivot) or CANCELS it (a fresh standalone
          // shopping request — "I'm on my feet 10 hours… what would you pick
          // first?" is a footwear ask, not a condition answer). The decision is
          // deterministic and shared with the gate so they never disagree.
          const orthoticFlowDecision = orthoticTree
            ? orthoticPendingFlowDecision({ messages, tree: orthoticTree })
            : "none";
          ctx.orthoticFlowDecision = orthoticFlowDecision;
          // "continue" keeps the orthotic target intact across the routing layers
          // below: (1) it stops soft-browse-refine from hijacking the turn into a
          // sneaker browse, and (2) it strips the shoe noun from the resolver
          // constraints so category never becomes "sneakers". A "cancel" turn
          // routes as a normal footwear/product turn (no orthotic ownership).
          const answeringOrthoticSeedQ = orthoticFlowDecision === "continue";

          // STAGE 2: resolver preflight
          try {
            const latestMsg = String(body.message || "");
            const skipResolver =
              !latestMsg.trim() ||
              (isPolicyOrServiceQuestion(latestMsg) && !isCompoundPolicyProductQuestion(latestMsg)) ||
              isBrandOrInfoQuestion(latestMsg) ||
              isCapabilityCheckAboutPriorProducts(latestMsg) ||
              detectUserSignupIntent(latestMsg);
            if (!skipResolver) {
              const extracted = extractUserConstraints(latestMsg);
              const classifiedAttrs = ctx.classifiedIntent?.attributes || {};
              // The orthotic classifier's `useCase` enums are
              // orthotic-specific terminology (dress_no_removable,
              // comfort_bundle, athletic_running, etc). Production
              // trace: customer asked "do you have any wedge that goes
              // with my blue dress?" — non-orthotic — and the
              // classifier returned useCase=dress_no_removable, which
              // the resolver then tried to match against the wedges
              // catalog and found 0, leading to confusing chip choices.
              // Only forward classifier useCase to the catalog resolver
              // on ACTUAL orthotic requests. For regular footwear, the
              // resolver derives use-case naturally from the message.
              const isOrthoticTurn = ctx.classifiedIntent?.isOrthoticRequest === true;
              const userConstraints = {
                ...extracted,
                ...(classifiedAttrs.gender ? { gender: classifiedAttrs.gender } : {}),
                ...(classifiedAttrs.condition ? { condition: classifiedAttrs.condition } : {}),
                ...(isOrthoticTurn && classifiedAttrs.useCase ? { useCase: classifiedAttrs.useCase } : {}),
              };
              // ORTHOTIC TARGET PRESERVATION. When answering the orthotic seed
              // shoe-environment question, the extracted footwear category
              // ("sneakers" from "Hoka sneakers") is the use-case answer, not a
              // product category — keep the target on orthotics so the resolver
              // never pins category=sneakers and a downstream search can't ship
              // sneaker cards (live trace 2026-06-30).
              if (answeringOrthoticSeedQ && userConstraints.category && messageStatesShoeEnvironment(latestMsg)) {
                console.log(
                  `[chat] ${ctx.shop} orthotic-flow: dropped category=${userConstraints.category} from a shoe-environment answer ` +
                    `to the orthotic seed question (it's a use-case/shoe-environment constraint, not a product category)`,
                );
                delete userConstraints.category;
              }
              try {
                const handle = await detectSpecificProduct(shop, latestMsg);
                if (handle) userConstraints.specificProduct = handle;
              } catch (sErr) {
                console.error("[resolver] specific-product detection failed:", sErr?.message || sErr);
              }
              const memory = buildSessionMemory({
                messages,
                classifiedIntent,
                resolverState: null, // resolver-inferred layered post-resolve below
              });
              ctx.sessionMemory = memory;
              const sessionMemory = { explicit: { ...memory.explicit } };
              const memoryDroppedGender =
                memory?.latestTurnIntent?.staleKeysToDrop?.includes("gender") === true;
              if (memoryDroppedGender && !latestPivotedGender && !genderAuthorityFromClassifier) {
                sessionGender = null;
                ctx.sessionGender = null;
              }
              // Fill from the authoritative session gender when memory
              // has none, OR overwrite when the classifier just took
              // authority over a stale regex value — otherwise the
              // resolver would see the regex gender while the search
              // uses the classifier's (split-brain).
              if (sessionGender && !memoryDroppedGender && (!sessionMemory.explicit.gender || genderAuthorityFromClassifier)) {
                sessionMemory.explicit.gender = sessionGender;
              }
              const resolverState = await resolveCatalogTurn({
                shop: shop,
                query: latestMsg,
                userConstraints,
                sessionMemory,
                messages,
                facetIndex: catalogFacetIndex,
                allowedCategories: catalogScopeCategories,
              });
              ctx.sessionMemory = buildSessionMemory({
                messages,
                classifiedIntent,
                resolverState,
              });
              const resolvedMemoryDroppedGender =
                ctx.sessionMemory?.latestTurnIntent?.staleKeysToDrop?.includes("gender") === true;
              if (
                sessionGender &&
                !resolvedMemoryDroppedGender &&
                (!ctx.sessionMemory.explicit?.gender ||
                  latestPivotedGender ||
                  genderAuthorityFromClassifier)
              ) {
                ctx.sessionMemory.explicit = {
                  ...(ctx.sessionMemory.explicit || {}),
                  gender: sessionGender,
                };
              }
              console.log(`[memory] ${ctx.shop} ${memorySummary(ctx.sessionMemory)}`);
              const memBlock = buildSessionMemoryPromptBlock(ctx.sessionMemory);
              if (memBlock) systemPrompt = systemPrompt + memBlock;
              if (resolverState && resolverState.type === "resolver_state") {
                ctx.resolverState = resolverState;
                const block = buildResolverStatePromptBlock(resolverState);
                if (block) systemPrompt = systemPrompt + block;
                routerLog.resolver =
                  `action=${resolverState.recommended_next_action?.type} ` +
                  `matched=${Object.keys(resolverState.matched_constraints).join(",") || "-"} ` +
                  `inferred=${Object.keys(resolverState.inferred_constraints).join(",") || "-"} ` +
                  `impossible=${resolverState.impossible_constraints.length} ` +
                  `candidates=${(resolverState.candidate_products || []).length}` +
                  (userConstraints.specificProduct ? ` specificProduct=${userConstraints.specificProduct}` : "");
              } else if (resolverState?.type === "skip") {
                routerLog.resolver = `skip reason=${resolverState.reason}`;
              }
            } else {
              routerLog.resolver = "skip reason=skip_helper_matched";
            }
          } catch (resolverErr) {
            console.error("[resolver] preflight threw, falling through:", resolverErr?.message || resolverErr);
            routerLog.resolver = `error ${resolverErr?.message || "unknown"}`;
          }

          // The orthotic seed question "What KIND OF shoes will the orthotics
          // go in?" trips shouldSoftBrowseRefine's broad-clarifier heuristic
          // ("what kind of" + a use-case word like "walking"), which would
          // short-circuit the orthotic answer into a generic sneaker browse
          // BEFORE the gate runs (live trace 2026-06-30: final_path=
          // soft_browse_refine, sneaker cards). When we're answering an
          // orthotic seed question, skip soft-browse and let the gate own it.
          if (
            !answeringOrthoticSeedQ && shouldSoftBrowseRefine(body.message, history) &&
            // OWNERSHIP: soft-browse-refine is a browse fallback — it may own the
            // turn ONLY when TurnPlan assigned a browse/clarification workflow. It
            // must never hijack a turn TurnPlan gave to a deterministic owner
            // (policy, availability, comparison, orthotic, …).
            ownerAuthorizedForWorkflow("soft-browse-refine", ctx.turnPlan?.workflow)
          ) {
            routerLog.finalPath = "soft_browse_refine";
            console.log(`[router] ${ctx.shop} ${routerLog.classifier}`);
            console.log(`[router] ${ctx.shop} ${routerLog.resolver || "resolver=skip"}`);
            console.log(`[router] ${ctx.shop} ${routerLog.orthoticGate || "handled=false case=pre-gate-soft-browse"}`);
            console.log(`[router] ${ctx.shop} final_path=${routerLog.finalPath}`);
            await emitSoftGenderGateBrowse({ ctx, controller, encoder });
            return;
          }

          // STAGE 3: orthotic gate decision (now receives resolverState)
          // OWNERSHIP: the orthotic guided flow is an authorized deterministic
          // owner, but only for workflows TurnPlan routes orthotic requests to
          // (browse / condition_recommendation / clarification / multi / compat /
          // sale). It must DEFER when TurnPlan owns the turn elsewhere (policy,
          // availability, comparison, product_spec, named-product, …) so it can't
          // override another owner (audit: TurnPlan is the only workflow owner).
          let gateHandled = false;
          const orthoticGateAuthorized = ownerAuthorizedForWorkflow("orthotic-gate", ctx.turnPlan?.workflow);
          if (orthoticTree && !orthoticGateAuthorized) {
            console.log(`[router] ${ctx.shop} orthotic-gate deferred — TurnPlan workflow=${ctx.turnPlan?.workflow} owned elsewhere`);
          }
          if (orthoticTree && orthoticGateAuthorized) {
            try {
              const gate = await maybeRunOrthoticFlow({
                messages,
                tree: orthoticTree,
                shop: shop,
                controller,
                encoder,
                anthropic,
                haikuModel: HAIKU_MODEL,
                classifiedIntent,
                turnPlan: ctx.turnPlan || null,
                resolverState: ctx.resolverState || null,
                storefrontSearchUrlPattern: String(config.storefrontSearchUrlPattern || ""),
                ctaOverrides,
              });
              gateHandled = !!gate?.handled;
              routerLog.orthoticGate = `handled=${gateHandled}` + (gate?.case ? ` case=${gate.case}` : "");
              // Shadow measurement (default OFF): when the gate engages,
              // ask the model what IT would do with the same conversation +
              // tools, and log agreement. Observation only — does not emit
              // to the customer or change the gate's behavior. This builds
              // the evidence to eventually move the engage/defer decision
              // from this pre-LLM gate to the model's recommend_orthotic tool.
              if (gateHandled) {
                const { isOrthoticGateShadowEnabled, logOrthoticGateShadow } = await import(
                  "../lib/llm-owns-turn.server.js"
                );
                if (isOrthoticGateShadowEnabled()) {
                  await logOrthoticGateShadow({
                    anthropic,
                    model: HAIKU_MODEL,
                    system: systemPrompt,
                    tools: activeTools,
                    messages,
                    shop,
                    gateCase: gate?.case || "engage",
                  });
                }
              }
              if (gateHandled) {
                routerLog.finalPath = "orthotic_gate";
                console.log(`[router] ${ctx.shop} ${routerLog.classifier}`);
                console.log(`[router] ${ctx.shop} ${routerLog.resolver || "resolver=skip"}`);
                console.log(`[router] ${ctx.shop} ${routerLog.orthoticGate}`);
                console.log(`[router] ${ctx.shop} final_path=${routerLog.finalPath}`);
                // The gate either asked a seed question (no cards) or emitted a
                // recommendation (cards) — either way it OWNS text and any cards.
                logTurnInvariant({
                  workflow: ctx.turnPlan?.workflow || "-", answerOwner: "orthotic-gate",
                  cardOwner: "orthotic-gate", finalCards: "-", path: "orthotic-gate",
                  extra: `case=${gate?.case || "-"}`,
                });
                return;
              }
              if (gate?.softGenderGateEscape) {
                routerLog.finalPath = "soft_gender_browse";
                console.log(`[router] ${ctx.shop} ${routerLog.classifier}`);
                console.log(`[router] ${ctx.shop} ${routerLog.resolver || "resolver=skip"}`);
                console.log(`[router] ${ctx.shop} ${routerLog.orthoticGate}`);
                console.log(`[router] ${ctx.shop} final_path=${routerLog.finalPath}`);
                const softCards = await emitSoftGenderGateBrowse({ ctx, controller, encoder });
                logTurnInvariant({
                  workflow: ctx.turnPlan?.workflow || "browse", answerOwner: "soft-gender-browse",
                  cardOwner: "soft-gender-browse", finalCards: typeof softCards === "number" ? softCards : "-",
                  path: "soft-gender-browse",
                });
                return;
              }
            } catch (gateErr) {
              console.error("[orthotic-flow] gate threw, falling through:", gateErr?.message || gateErr);
              routerLog.orthoticGate = `error ${gateErr?.message || "unknown"}`;
            }
          }
          if (!routerLog.orthoticGate) routerLog.orthoticGate = "handled=false case=none";

          const resolverAction = ctx.resolverState?.recommended_next_action?.type;
          routerLog.finalPath =
            resolverAction && resolverAction !== "skip" && resolverAction !== "ask"
              ? "resolver"
              : "llm";
          console.log(`[router] ${ctx.shop} ${routerLog.classifier}`);
          console.log(`[router] ${ctx.shop} ${routerLog.resolver || "resolver=skip"}`);
          console.log(`[router] ${ctx.shop} ${routerLog.orthoticGate}`);
          console.log(`[router] ${ctx.shop} final_path=${routerLog.finalPath}`);

          {
            const guard = detectFootwearOverElicitation({
              classifiedIntent: ctx.classifiedIntent,
              latestUserMessage: String(body.message || ""),
              establishedGender:
                ctx.classifiedIntent?.attributes?.gender ||
                detectLatestGender(
                  messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"),
                ),
              catalogProductTypes,
              isFollowUp: ctx.turnIsFollowUp === true,
            });
            if (guard) {
              systemPrompt = systemPrompt + guard.directive;
              console.log(
                `[chat] ${ctx.shop} footwear-over-elicitation guard fired: ` +
                  `gender=${guard.gender} category=${guard.category} — ` +
                  `injected force-search directive into system prompt.`,
              );
            }
          }

          // ──────────────────────────────────────────────────────────
          // Phase 1 — Product Turn Engine dispatch
          //
          // For clear claim-carrying product retrieval turns, the
          // engine OWNS the answer: scope → retrieve → attach facts
          // → group variants → select by proof → compose seller-
          // spirit copy. No LLM agent loop, no verifier round-trip.
          // The engine declines (returns null/decline=true) for
          // named-product, compare-shape, and category-less turns —
          // those fall through to the existing agent path below
          // unchanged.
          //
          // Default OFF: requires PRODUCT_TURN_ENGINE_ENABLED=true.
          // Engine searchFn reuses dispatchTool("search_products",
          // …) so we don't build a second search system.
          //
          // ──────────────────────────────────────────────────────────
          // Phase 1 migration — LLM_OWNS_ALL_TURNS short-circuit.
          //
          // When the flag is on, skip the dispatcher cascade (variant-
          // fact / policy / resolver-no-match / product-engine). One
          // model invocation owns the turn, with the grounding
          // validator catching ungrounded claims and asking the model
          // to fix them (max 2 retries) before anything reaches the
          // customer. NOTE: the in-loop post-processors inside
          // runAgenticLoop (cleanup pipeline, card guards, response
          // contract) STILL RUN on this path — only the cascade is
          // skipped. Phase 4 removes the in-loop mutators that fight
          // the model. The orthotic gate stays in front because it's
          // a real business workflow that ALREADY ran above this
          // point — we honor its result.
          //
          // Default OFF: requires LLM_OWNS_ALL_TURNS=true. When
          // LLM_OWNS_ALL_TURNS_SHADOW=true (and the main flag is
          // OFF), the new path runs in parallel into a discard buffer
          // and only its diff vs. the old answer is logged.
          // ──────────────────────────────────────────────────────────
          // Follow-up suggestion generation — shared by the LLM-owns and
          // legacy paths so the admin "Follow-up questions" toggle works
          // identically on both. Returns the Haiku usage object (or null).
          const emitFollowUpSuggestions = async ({ lastText, recommenderInvoked, cardsCount = 0 }) => {
            const hasChoiceButtons = /<<[^<>]+>>/.test(lastText);
            if (config.showFollowUps === false || hasChoiceButtons || recommenderInvoked) return null;
            // SUPPORT / POLICY / SIZING handoff turns never get product-shopping
            // quick replies ("Show me sneakers", "What's good for standing all
            // day?") — those are wrong on a teacher-verification / order / account
            // answer (live trace 2026-06-30). Emit no quick replies on these turns.
            const handoffWf = ctx?.turnPlan?.workflow;
            if (
              handoffWf === "policy_knowledge" || handoffWf === "account_private_handoff" ||
              handoffWf === "policy_account" || handoffWf === "customer_service" || handoffWf === "sizing_help"
            ) {
              console.log(`[chat] ${ctx.shop} follow-ups suppressed: ${handoffWf} is a knowledge/support turn (no product quick replies)`);
              return null;
            }
            // Orthotic↔sandal compatibility class: emit DETERMINISTIC Aetrex-safe
            // follow-ups and skip the LLM roundtrip. The model otherwise proposes
            // "Show me sandals with removable footbeds", which the catalog can't
            // satisfy (dropped later as catalog_intersection_empty) — leaving the
            // customer with no next step. Offer supportive sandals / closed-shoe
            // orthotics / shoes-vs-orthotics instead.
            if (isOrthoticSandalCompatibilityQuestion(String(body.message || ""))) {
              controller.enqueue(encoder.encode(sseChunk({ type: "suggestions", questions: SAFE_COMPATIBILITY_SUGGESTIONS.slice(0, 3) })));
              console.log(`[chat] ${ctx.shop} compatibility-truth: emitted ${SAFE_COMPATIBILITY_SUGGESTIONS.length} safe follow-up(s) (no removable-footbed sandal)`);
              return null;
            }
            // Cost gate: when the reply attached product cards, the cards
            // ARE the customer's next move — text suggestions duplicate
            // them and add a Haiku roundtrip. When the reply is very
            // short, there's nothing meaningful to pivot off. Skip
            // both. Verified against scoreboard runs as quality-neutral.
            if (cardsCount > 0) return null;
            if ((lastText || "").trim().length < 50) return null;
            try {
              const catalogLine = catalogProductTypes.length > 0
                ? `\nCATALOG (allowed categories): ${catalogProductTypes.join(", ")}.`
                : "";
              // Shrunk from ~700 → ~140 tokens. The follow-up validator
              // (chat-postprocessing.validateFollowUpSuggestions) drops
              // every failure mode the old prose list enumerated —
              // off-catalog categories, branded-tech deep-dives, spec
              // numbers, gender contradictions, dupes — so the model
              // doesn't need to remember each rule; the validator is
              // the contract. Net savings: ~50% per call, behavior
              // identical because the gate hasn't moved.
              const fuRes = await anthropic.messages.create({
                model: HAIKU_MODEL,
                max_tokens: 150,
                messages: [
                  {
                    role: "user",
                    content:
                      `Customer asked: "${String(body.message).slice(0, 200)}"\n` +
                      `Assistant replied: "${lastText.slice(0, 300)}"` +
                      catalogLine +
                      `\n\nSuggest 2-3 short follow-up questions the customer would tap next. Pivots (different gender / category / price / width) are usually better than deep-dives on tech or specs. Use only categories the assistant mentioned or from the allowed list above. Each suggestion is sent AS the customer's next message — write it in first-person customer voice, e.g. "Show me women's sneakers", "Do you have wide widths?", "What's good for all-day walking?". Never write assistant-voice questions to the customer ("Do you prefer...", "Are you looking for...", "Do you need...", "Would you like...").\n\nReturn ONLY a JSON array of short strings.`,
                  },
                ],
              });
              const raw = fuRes.content?.[0]?.text || "";
              const match = raw.match(/\[[\s\S]*\]/);
              if (match) {
                let questions = JSON.parse(match[0]).filter((q) => typeof q === "string").slice(0, 3);
                // Server-side validator. Even with tightened prompt
                // rules, Haiku occasionally generates questions the
                // main AI can't answer (tech-name deep-dives, spec
                // numbers, deeply branded terms). Strip those before
                // emit. Customer is better off with 1-2 good
                // suggestions than 3 with one that triggers a
                // hallucinated reply on the next turn.
                // Established gender from the conversation, used to drop
                // suggestions that name the opposite gender (logic + unit
                // tests live in chat-postprocessing.suggestionContradictsGender).
                const conversationTextForGender = messages
                  .map((m) => (typeof m.content === "string" ? m.content : ""))
                  .join("\n");
                const establishedGender = detectLatestGender(conversationTextForGender);
                const filtered = [];
                const dropped = [];
                for (const q of questions) {
                  if (suggestionContradictsGender(q, establishedGender)) {
                    dropped.push({ q, reason: `gender contradicts established=${establishedGender}` });
                    continue;
                  }
                  // Never suggest an orthotic-compatible / removable-footbed
                  // sandal — the catalog can't satisfy it (drop by intent, not
                  // incidentally via catalog_intersection_empty).
                  if (isUnsafeCompatibilitySuggestion(q)) {
                    dropped.push({ q, reason: "unsupported_compatibility_suggestion" });
                    continue;
                  }
                  // Single code-owned answerability gate: never suggest a
                  // follow-up the bot can't answer (spec deep-dives, branded
                  // tech names, unverifiable discount mechanics).
                  const verdict = isUnanswerableSuggestion(q, {
                    lastText,
                    latestUserMessage: String(body.message || ""),
                    catalogCategories: allCatalogCategories,
                    categoryAttributeCoverage,
                  });
                  if (verdict.unanswerable) {
                    dropped.push({ q, reason: verdict.reason });
                    continue;
                  }
                  const catalogVerdict = catalogGroundedSuggestionVerdict(q, ctx);
                  if (!catalogVerdict.possible) {
                    dropped.push({
                      q,
                      reason:
                        `${catalogVerdict.reason}; ` +
                        `scope=${JSON.stringify(catalogVerdict.effectiveConstraints)}`,
                    });
                    continue;
                  }
                  filtered.push(q);
                }
                if (dropped.length > 0) {
                  console.log(
                    `[chat] ${ctx.shop} follow-up validator: dropped ${dropped.length}/${questions.length} suggestion(s) — ` +
                      dropped.map((d) => `"${d.q.slice(0, 50)}" (${d.reason})`).join("; "),
                  );
                }
                questions = filtered;
                if (questions.length > 0) {
                  controller.enqueue(encoder.encode(sseChunk({ type: "suggestions", questions })));
                }
              }
              return fuRes.usage || null;
            } catch (fuErr) {
              console.error("[chat] follow-up error:", fuErr?.message);
              return null;
            }
            return null;
          };

          const {
            isLlmOwnsTurnEnabled,
            isShadowModeEnabled,
            runWithGroundingRetry,
          } = await import("../lib/llm-owns-turn.server.js");
          if (isLlmOwnsTurnEnabled()) {
            const sonnetModelForClean = (() => {
              const stored = config.anthropicModel || DEFAULT_MODEL;
              return DEPRECATED_MODELS.has(stored) ? DEFAULT_MODEL : stored;
            })();
            // Hybrid model routing (cost), honoring the merchant's
            // Model Strategy setting from the admin panel (app/api-keys):
            //   smart (default)  — Haiku for standard turns; the
            //                      configured Standard model for compare
            //                      turns and ALL validator retries (a
            //                      rejected attempt escalates to the
            //                      stronger model for the correction).
            //   cost-optimized   — Haiku for everything except validator
            //                      retries. Lowest spend; the validator
            //                      escalation keeps facts correct.
            //   always-opus      — every turn on the Advanced model.
            //   always-sonnet    — every turn on the Standard model
            //                      (legacy stored value).
            //   always-haiku     — every turn on the Fast model
            //                      (legacy stored value).
            // HYBRID_MODEL_ROUTING=false pins everything back to the
            // configured Standard model regardless of strategy.
            const hybridRouting =
              String(process.env.HYBRID_MODEL_ROUTING || "").toLowerCase() !== "false";
            const turnStrategy = String(config.modelStrategy || "smart");
            const latestForRouting = String(body.message || "");
            // Sales-judgment turns (condition/advisory/comparison/multi) need
            // taste + the direct sales voice — the fast model tends to narrate
            // its process here, which the validator then blocks (an extra retry).
            // Route them straight to the stronger model on attempt 0. Simple
            // browse/policy/availability stay on the fast model for cost.
            const workflowNeedsStrongModel = SALES_JUDGMENT_WORKFLOWS.has(ctx?.turnPlan?.workflow || "");
            const needsStrongModel =
              workflowNeedsStrongModel ||
              detectComparisonIntent(latestForRouting) ||
              /\b(?:vs\.?|versus|difference between|compare)\b/i.test(latestForRouting) ||
              // Review / fit / durability / value questions need a grounded
              // synthesis from review+return data. Haiku tends to answer
              // these in a process-narration voice that the banned-narration
              // scrubber then guts to a fragment, so the substantive half
              // goes unanswered (prod trace 2026-06-24, Jillian strap/instep
              // + "can I return it"). Sonnet follows the direct-voice rules,
              // so route these straight to it on the first attempt.
              /\b(?:reviews?\s+say|what\s+do\s+(?:reviewers?|customers?|buyers?|people)\s+(?:say|think)|runs?\s+(?:narrow|wide|small|large|big|tight)|true\s+to\s+size|size\s+up|size\s+down|high\s+instep|wide\s+(?:foot|feet|width)|narrow\s+(?:foot|feet|width)|hold[s]?\s+up|durab|well[-\s]?made|worth\s+(?:it|the\s+price|that)|how\s+long\s+(?:do|does|will)\s+(?:it|they|these)\s+last|can\s+i\s+return|does\s+the\s+(?:adjustable|strap|hook|buckle))\b/i.test(latestForRouting) ||
              // Vague footwear-browse / availability turns: "do you have men's
              // shoes?", "what shoes are good for…", "what shoes or insoles
              // have worked…". Haiku over-elicits here (asks "for yourself or
              // someone else?" instead of searching and showing products /
              // category chips). Sonnet follows the search + category-chip
              // rules, so route these to it on attempt 0. Explicit searches
              // ("show me women's sneakers", "black sneakers") DON'T match —
              // those already work on Haiku and stay cheap.
              /\b(?:do\s+you\s+(?:have|carry|sell)|what\s+(?:shoes?|footwear|kind\s+of\s+(?:shoes?|footwear))|what\s+(?:would|should|do\s+you\s+recommend))\b[^.?!\n]{0,60}\b(?:shoes?|footwear|sneakers?|sandals?|boots?|loafers?|clogs?|slippers?|insoles?|orthotics?|wear|walk|stand|feet|foot|arch|heel)\b/i.test(latestForRouting) ||
              /\b(?:shoes?|footwear|insoles?|orthotics?)\b[^.?!\n]{0,40}\b(?:or|and)\b[^.?!\n]{0,40}\b(?:shoes?|footwear|insoles?|orthotics?)\b/i.test(latestForRouting) ||
              // Advisory / value / medical-adjacent judgment questions. Haiku
              // writes weak, hedgy, or process-narrated first drafts on these
              // ("is the Jillian good for plantar fasciitis?", "is it worth
              // it?", "which should I buy?", "casual or active?"), which then
              // burn validator retries. Sonnet answers them cleanly first-try,
              // so route straight to it (one Sonnet call beats Haiku + a Sonnet
              // retry). Simple browse/search stays on Haiku.
              /\b(?:plantar|fasciitis|bunion|neuroma|metatarsal|overpronat|supinat|sesamoid|capsulitis|fallen\s+arch|flat\s+feet|heel\s+(?:pain|spur)|arch\s+(?:pain|support))\b/i.test(latestForRouting) ||
              /\bis\s+(?:it|this|that|the|these|they)\b[^.?!\n]{0,45}\b(?:good\s+for|worth|casual|active|sporty|dressy|formal|suitable|right\s+for|enough)\b/i.test(latestForRouting) ||
              /\b(?:which\s+(?:one\s+)?should\s+i|should\s+i\s+(?:buy|get|order|choose|pick)|more\s+of\s+a)\b/i.test(latestForRouting);
            const pickModel = (attempt) => {
              if (!hybridRouting) return sonnetModelForClean;
              if (turnStrategy === "always-opus") return OPUS_MODEL;
              if (turnStrategy === "always-haiku") return HAIKU_MODEL;
              if (turnStrategy === "always-sonnet") return sonnetModelForClean;
              if (turnStrategy === "cost-optimized") {
                return attempt > 0 || needsStrongModel ? sonnetModelForClean : HAIKU_MODEL;
              }
              // smart (default)
              if (attempt > 0 || needsStrongModel) return sonnetModelForClean;
              return HAIKU_MODEL;
            };
            // Each attempt runs into its OWN buffer — only the accepted
            // attempt's chunks flush to the live controller. Without
            // this, a failed attempt's text would stream to the widget
            // and the retry's text would stream again (duplicate reply).
            let attemptBuf = [];
            const runLoopOnce = async ({ messages: msgs, attempt = 0, rewriteOnly = false, carriedCards = null, carriedCardOwner = null, carriedEvidenceFallbackText = null }) => {
              attemptBuf = [];
              const turnModel = pickModel(attempt);
              if (turnModel !== sonnetModelForClean) {
                console.log(`[llm-owns-turn] ${ctx.shop} model=${turnModel} (hybrid, attempt=${attempt + 1}${rewriteOnly ? ", rewrite-only" : ""})`);
              }
              return await runAgenticLoop({
                anthropic,
                model: turnModel,
                systemPrompt,
                promptStableLength,
                messages: msgs.slice(),
                // Rewrite-only retries reuse the prior attempt's cards (no
                // re-search). Carry them + the owner so the pin blocks restore
                // them and the scorer never takes over the turn.
                ctx: { ...ctx, rewriteOnlyRetry: rewriteOnly, carriedCards, carriedCardOwner, carriedEvidenceFallbackText },
                controller: { enqueue: (c) => attemptBuf.push(c) },
                encoder,
                forceNoTools: rewriteOnly,
                deferTextEmit: true,
                // Force prompt caching ON for the LLM-owns path. The
                // system prompt is ~80KB and goes to Sonnet on EVERY
                // hop; without caching, Anthropic re-reads it from
                // scratch each call, costing 5-10 extra seconds per
                // turn. ShopConfig.promptCaching defaults to false
                // (legacy field), but for the new architecture it
                // should always be on — the cache TTL is plenty for
                // a multi-hop turn and the cost is essentially free.
                // Live trace 2026-06-10: hiking-poles single-hop turn
                // took 14.5s; chartreuse two-hop turn took 13s.
                promptCaching: true,
                tools: activeTools,
              });
            };
            // Fix #2: did the customer NAME a catalog product this turn? If
            // so, a value/fit/condition question about it must be grounded in
            // fetched product data (the validator's missing_product_lookup
            // rule). Gate the catalog query behind a cheap intent regex so
            // plain browse turns don't pay a DB round-trip.
            let namedProductMentioned = false;
            const latestForNamed = ctx.latestUserMessage || "";
            if (/\b(?:worth|hold\s+up|good\s+for|durable|plantar|fasciitis|bunion|neuroma|metatarsal|size|sizing|fit|fits|in\s+stock|come[s]?\s+in|available|which\s+(?:one\s+)?should|should\s+i\s+(?:buy|get|order|choose)|more\s+of\s+a|all[-\s]?day|walking|standing)\b/i.test(latestForNamed)) {
              try {
                // Family-level: "Jillian"/"Savannah"/"Danika" count as named
                // products even when ambiguous across variants.
                namedProductMentioned = await mentionsCatalogProductFamily(ctx.shop, latestForNamed);
              } catch (err) {
                console.error(`[named-product] detection failed:`, err?.message || err);
              }
            }
            const cleanResult = await runWithGroundingRetry({
              runLoop: runLoopOnce,
              initialMessages: messages,
              categoryGenderMap: ctx.categoryGenderMap || null,
              userMessage: ctx.latestUserMessage || "",
              namedProductMentioned,
              turnPlan: ctx.turnPlan || null,
              maxRetries: 2,
              onAttempt: ({ attempt, validation, textLen, poolSize }) => {
                console.log(
                  `[llm-owns-turn] ${ctx.shop} attempt=${attempt + 1} ` +
                    `ok=${validation.ok} errors=${validation.errors.length} ` +
                    `textLen=${textLen} pool=${poolSize}` +
                    (validation.errors.length > 0
                      ? ` first_error=${JSON.stringify(validation.errors[0]?.claim || "")}`
                      : ""),
                );
              },
            });
            // FINAL SAFETY GATE — validator exhausted (ok=false after retries).
            // Don't ship the uncertain/non-answer draft: hand off to Aetrex
            // customer service. (Text-detectable handoffs already ran in-loop;
            // this catches "the model never got it right".) Drop the buffered
            // cards/links and emit empty products + the support link instead.
            if (cleanResult.needsSupportHandoff && !cleanResult.qualitySignals?.supportHandoffApplied) {
              const hasUrl = supportConfigured(ctx);
              cleanResult.fullResponseText = buildSupportHandoffText({ ctx, reason: "validation_failed", partial: false });
              // Drop the buffered cards/links; emit empty products + a live-chat
              // support_cta button (Zendesk/Intercom/Gorgias, Support Hub URL as
              // fallback) — never the plain link anchor.
              attemptBuf = [encoder.encode(sseChunk({ type: "products", products: [] }))];
              if (hasUrl) attemptBuf.push(encoder.encode(sseChunk({ type: "support_cta", label: supportChatLabel(ctx), fallbackUrl: ctx.supportUrl })));
              if (cleanResult.turnResult) cleanResult.turnResult.products = [];
              cleanResult.finalProductCards = [];
              console.log(`[handoff] mode=hard reason=validation_failed support=${hasUrl} cards=0`);
            }
            // SALES VOICE — final emit scrub (backup to the validator block).
            // If any process-narration sentence survived ("I see I'm getting
            // mostly sneakers…", "let me try one more search"), remove only that
            // sentence. If the scrub leaves a fragment, use a warm, sales-safe
            // fallback (recommendation-first, never "I'm not finding a match").
            {
              const before = cleanResult.fullResponseText || "";
              const narration = detectProcessNarration(before);
              if (narration.hit) {
                const wf = ctx?.turnPlan?.workflow || "";
                const finalCardCount =
                  cleanResult.turnResult?.products?.length
                  || cleanResult.finalProductCards?.length
                  || 0;
                let scrubbed = stripProcessNarration(before);
                if (scrubbed.trim().length < 40) {
                  scrubbed = buildSalesVoiceFallback({ workflow: wf, hasCards: finalCardCount > 0 });
                }
                cleanResult.fullResponseText = scrubbed;
                console.log(
                  `[sales-voice] scrubbed process narration (${narration.sentences.length} sentence(s)) ` +
                  `workflow=${wf} ${before.length}→${scrubbed.length} chars` +
                  (scrubbed === buildSalesVoiceFallback({ workflow: wf, hasCards: finalCardCount > 0 }) ? " (fallback)" : ""),
                );
              }
            }
            // Emit the AUTHORITATIVE final text first (text emit was
            // deferred in runAgenticLoop). runWithGroundingRetry sets
            // fullResponseText to the accepted answer, a shortened recovered
            // answer, or a safe deterministic fallback — never the failed
            // draft or a "tell me more" fragment. Then flush the final
            // buffer (cards/CTAs only — no text chunk).
            controller.enqueue(encoder.encode(sseChunk({
              type: "text",
              text: cleanResult.fullResponseText || "",
            })));
            for (const c of attemptBuf) controller.enqueue(c);
            // Honor the admin "Follow-up questions" toggle on this path
            // too — previously only the legacy path generated them, so
            // the setting silently did nothing under LLM_OWNS_ALL_TURNS.
            let llmOwnsFuUsage = null;
            try {
              llmOwnsFuUsage = await emitFollowUpSuggestions({
                lastText: cleanResult.fullResponseText || "",
                recommenderInvoked: cleanResult.recommenderInvokedThisTurn === true,
                cardsCount: (cleanResult.turnResult?.products?.length
                  || cleanResult.finalProductCards?.length
                  || 0),
              });
            } catch (fuErr) {
              console.error("[chat] follow-up error (llm-owns):", fuErr?.message);
            }
            controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
            const finalCards =
              cleanResult.turnResult?.products
              || cleanResult.finalProductCards
              || [];
            // Cache instrumentation. After enabling promptCaching=true,
            // cache_read_input_tokens should be ~78K on every turn
            // after the first one in a session — Anthropic re-reads
            // the cached system prompt at ~10× the rate. Without
            // caching every turn re-billed and re-processed those
            // tokens, dominating latency. Live trace 2026-06-10
            // showed 14.5s hops; this should cut them substantially.
            const usage = cleanResult.totalUsage || {};
            if (llmOwnsFuUsage) addUsage(usage, llmOwnsFuUsage);
            console.log(
              `[llm-owns-turn] ${ctx.shop} final ok=${cleanResult.validation.ok} ` +
                `attempts=${cleanResult.validation.attempts} ` +
                `textLen=${(cleanResult.fullResponseText || "").length} ` +
                `cards=${finalCards.length} ` +
                `cache=read:${usage.cache_read_input_tokens || 0}/` +
                `write:${usage.cache_creation_input_tokens || 0}/` +
                `fresh:${usage.input_tokens || 0}`,
            );
            // Record usage for the admin Analytics dashboard and the
            // daily message cap. Previously only the legacy path
            // recorded — under LLM_OWNS_ALL_TURNS the dashboard showed
            // zero cost/messages and the daily cap could never trigger.
            // Skipped for `internal` (admin test-chat) requests so the
            // merchant's own testing never pollutes their analytics.
            if (!internal) {
              recordChatUsage({
                shop: shop,
                model: cleanResult.model || pickModel(0),
                usage,
                toolCalls: cleanResult.toolCallCount || 0,
                embeddingTokens: ctx.embeddingUsage.tokens,
                embeddingCostUsd: computeEmbeddingCost(ctx.embeddingUsage.provider, ctx.embeddingUsage.tokens),
              }).catch((err) => console.error("[chat] usage log error:", err?.message));
            }
            return;
          }
          let shadowResultForDiff = null;
          if (isShadowModeEnabled()) {
            // Shadow run: don't stream to the customer. The old path
            // owns the response; we just record what the new path
            // would have produced and diff it.
            try {
              const sonnetModelForShadow = (() => {
                const stored = config.anthropicModel || DEFAULT_MODEL;
                return DEPRECATED_MODELS.has(stored) ? DEFAULT_MODEL : stored;
              })();
              const discardBuf = [];
              const runLoopOnce = async ({ messages: msgs }) => {
                return await runAgenticLoop({
                  anthropic,
                  model: sonnetModelForShadow,
                  systemPrompt,
                  messages: msgs.slice(),
                  ctx: { ...ctx },
                  controller: { enqueue: (c) => discardBuf.push(c) },
                  encoder,
                  // Match the live path: force prompt caching ON.
                  promptCaching: true,
                  tools: activeTools,
                });
              };
              shadowResultForDiff = await runWithGroundingRetry({
                runLoop: runLoopOnce,
                initialMessages: messages,
                maxRetries: 2,
              });
              console.log(
                `[llm-owns-turn:shadow] ${ctx.shop} shadow-run complete ` +
                  `ok=${shadowResultForDiff.validation.ok} ` +
                  `attempts=${shadowResultForDiff.validation.attempts} ` +
                  `textLen=${(shadowResultForDiff.fullResponseText || "").length} ` +
                  `cards=${(shadowResultForDiff.finalProductCards || []).length}`,
              );
            } catch (shadowErr) {
              console.warn(
                `[llm-owns-turn:shadow] ${ctx.shop} shadow run failed (ignored): ` +
                  `${shadowErr?.message || shadowErr}`,
              );
            }
          }

          // ──────────────────────────────────────────────────────────
          // Phase 3 — Policy / Knowledge dispatcher.
          //
          // Policy / service / knowledge questions (return policy,
          // shipping, warranty, exchanges, tracking, discounts,
          // services, terms) come BEFORE the product engine — they
          // must NEVER trigger a product search. Answers are
          // composed from the merchant's admin-uploaded
          // KnowledgeFile content (via the already-resolved
          // retrievedChunks for this request). Engine declines
          // and falls through if no policy intent is detected.
          // ──────────────────────────────────────────────────────────
          // OWNERSHIP: the legacy dispatcher engines run only when LLM_OWNS is
          // off (dead in prod). Even then, each may claim ONLY a workflow
          // TurnPlan assigned to it — never on its own detector alone.
          const variantFactResult = ownerAuthorizedForWorkflow("variant-facts", ctx.turnPlan?.workflow)
            ? await runVariantFactDispatch({ ctx, controller, encoder })
            : null;
          if (variantFactResult && variantFactResult.handled) {
            console.log(`[router] ${ctx.shop} final_path=variant_fact_engine`);
            console.log(
              `[variant-facts] handled shop=${ctx.shop} ` +
                `usedSearch=${variantFactResult.diagnostics?.usedSearch ? "yes" : "no"} ` +
                `colors=${variantFactResult.diagnostics?.colors || 0} ` +
                `otherColors=${variantFactResult.diagnostics?.otherColors || 0} ` +
                `textLen=${variantFactResult.answerText?.length || 0}`,
            );
            logTurnInvariant({
              workflow: ctx.turnPlan?.workflow || "availability", answerOwner: "variant-facts",
              cardOwner: (variantFactResult.products?.length || 0) > 0 ? "variant-facts" : "none",
              finalCards: variantFactResult.products?.length ?? "-", path: "variant-facts",
            });
            return;
          }

          const compoundPolicyProduct = isCompoundPolicyProductQuestion(body.message);
          const directProductFact = isDirectProductFactQuestion(body.message);
          const orthoticRecommendationIntent = isOrthoticRecommendationIntent(body.message);

          const policyResult = (compoundPolicyProduct || !ownerAuthorizedForWorkflow("policy-engine", ctx.turnPlan?.workflow))
            ? null
            : await runPolicyTurnDispatch({
                ctx, controller, encoder, retrievedChunks, anthropic,
              });
          if (policyResult && policyResult.handled) {
            // final_path log overrides any earlier "final_path=llm"
            // line — the router logs that before dispatcher runs.
            // Surface the engine win prominently for log readers.
            console.log(`[router] ${ctx.shop} final_path=policy_engine`);
            console.log(
              `[policy-engine] handled shop=${ctx.shop} ` +
                `intent=${policyResult.diagnostics?.intent?.primary || "-"} ` +
                `composer=${policyResult.diagnostics?.composer || "-"} ` +
                `topSim=${policyResult.diagnostics?.topSimilarity?.toFixed?.(2) || "-"} ` +
                `ctaUrl=${policyResult.diagnostics?.ctaUrl ? "yes" : "no"} ` +
                `followUps=${policyResult.diagnostics?.followUps || 0} ` +
                `textLen=${policyResult.answerText?.length || 0}`,
            );
            // Policy answers from KnowledgeFile content; cards are intentionally
            // suppressed (display=suppress) — log so the empty carousel is owned.
            logTurnInvariant({
              workflow: ctx.turnPlan?.workflow || "policy_account", answerOwner: "policy-engine",
              cardOwner: "none", finalCards: 0, path: "policy-engine",
            });
            return; // policy emitted text/products(empty)/done; no agent loop.
          }
          if (policyResult && policyResult.declined && policyResult.diagnostics?.intent) {
            // Intent classified but knowledge was empty AND we
            // chose to fall through (rare — composer normally
            // composes the honest-admit line). Log for visibility.
            console.log(
              `[policy-engine] declined shop=${ctx.shop} ` +
                `intent=${policyResult.diagnostics.intent.primary} ` +
                `— falling through to agent path`,
            );
          }

          const resolverNoMatchResult = ownerAuthorizedForWorkflow("resolver-no-match", ctx.turnPlan?.workflow)
            ? await runResolverNoMatchDispatch({ ctx, controller, encoder })
            : null;
          if (resolverNoMatchResult && resolverNoMatchResult.handled) {
            console.log(`[router] ${ctx.shop} final_path=resolver_no_match`);
            console.log(
              `[resolver-no-match] handled shop=${ctx.shop} ` +
                `reason=${resolverNoMatchResult.diagnostics?.reason || "-"} ` +
                `impossible=${(resolverNoMatchResult.diagnostics?.impossible || [])
                  .map((item) => `${item?.field || "?"}:${item?.value || "?"}`)
                  .join("|") || "-"} ` +
                `textLen=${resolverNoMatchResult.answerText?.length || 0}`,
            );
            logTurnInvariant({
              workflow: ctx.turnPlan?.workflow || "-", answerOwner: "resolver-no-match",
              cardOwner: "none", finalCards: 0, path: "resolver-no-match",
              extra: `reason=${resolverNoMatchResult.diagnostics?.reason || "-"}`,
            });
            return; // exact catalog no-match emitted text/products(empty)/done.
          }

          const engineResult = (compoundPolicyProduct || directProductFact || orthoticRecommendationIntent || !ownerAuthorizedForWorkflow("product-engine", ctx.turnPlan?.workflow))
            ? { declined: true, diagnostics: { rungs: [
                compoundPolicyProduct ? "declined:compound_policy_product" : null,
                directProductFact ? "declined:direct_product_fact" : null,
                orthoticRecommendationIntent ? "declined:orthotic_recommendation_intent" : null,
                !ownerAuthorizedForWorkflow("product-engine", ctx.turnPlan?.workflow) ? "declined:workflow_not_authorized" : null,
              ].filter(Boolean) } }
            : await runProductTurnDispatch({
                ctx, controller, encoder, claimConfig, anthropic,
              });
          if (engineResult && engineResult.handled) {
            console.log(`[router] ${ctx.shop} final_path=product_engine`);
            console.log(
              `[product-turn-engine] handled shop=${ctx.shop} ` +
                `families=${engineResult.diagnostics?.rungs?.join("|") || "-"} ` +
                `selection=${engineResult.diagnostics?.selectionReason || "-"} ` +
                `composer=${engineResult.diagnostics?.composer || "-"} ` +
                `cta=${engineResult.diagnostics?.cta || "-"} ` +
                `textLen=${engineResult.answerText?.length || 0} ` +
                `cards=${engineResult.products?.length || 0}`,
            );
            logTurnInvariant({
              workflow: ctx.turnPlan?.workflow || "-", answerOwner: "product-engine",
              cardOwner: (engineResult.products?.length || 0) > 0 ? "product-engine" : "none",
              finalCards: engineResult.products?.length ?? "-", path: "product-engine",
            });
            return; // engine emitted text+products+done; no agent loop.
          }
          if (engineResult && engineResult.declined) {
            console.log(
              `[product-turn-engine] declined shop=${ctx.shop} ` +
                `rungs=${(engineResult.diagnostics?.rungs || []).join("|") || "-"} — ` +
                `falling through to agent path`,
            );
          }

          // Haiku→Sonnet escalation (cost-optimized mode only). On a
          // low-risk turn routed to Haiku, run it into a BUFFER (nothing
          // reaches the widget yet). If the result looks weak (empty text,
          // or searched-but-no-cards), silently re-run the turn on Sonnet
          // and flush THAT instead. Healthy Haiku turns flush unchanged.
          // Strictly gated: Smart / always-* modes take the original path
          // below, byte-for-byte. Each run gets a fresh messages copy
          // (runAgenticLoop pushes tool turns onto it) and a shallow ctx
          // clone so the buffered attempt can't pollute a retry.
          const modelStrategy = config.modelStrategy || "smart";
          const sonnetModel = (() => {
            const stored = config.anthropicModel || DEFAULT_MODEL;
            return DEPRECATED_MODELS.has(stored) ? DEFAULT_MODEL : stored;
          })();
          // Reactive Sonnet→Opus escalation. The whole turn is already
          // buffered server-side (nothing streams token-by-token), so we
          // run the chosen model into a BUFFER, inspect the loop's
          // quality signals, and — when a fact-validator caught the model
          // reasoning wrong this turn — silently re-run on Opus and flush
          // THAT instead. Enabled for every mode whose answering model
          // isn't already Opus; merchant can disable via config.
          const baseOpts = {
            anthropic, systemPrompt, encoder,
            promptCaching: config.promptCaching === true,
            tools: activeTools,
          };
          const opusModel = OPUS_MODEL;
          const opusEscalationEnabled =
            config.opusEscalation !== false && modelStrategy !== "always-opus";
          // Run a model into its own buffer with a fresh messages copy +
          // shallow ctx clone so a buffered attempt never pollutes a retry.
          const runBuffered = async (m) => {
            const buf = [];
            const r = await runAgenticLoop({
              ...baseOpts, model: m, messages: messages.slice(), ctx: { ...ctx },
              controller: { enqueue: (c) => buf.push(c) },
            });
            return { buf, r };
          };

          let result;
          let chosenBuf;
          if (modelStrategy === "cost-optimized" && model === HAIKU_MODEL) {
            const { buf: haikuBuf, r: haikuResult } = await runBuffered(model);
            const esc = haikuEscalationSignal({
              isHaiku: true,
              productSearchAttempted: haikuResult.productSearchAttempted,
              poolSize: haikuResult.turnResult?.products?.length ?? 0,
              textLen: (haikuResult.fullResponseText || "").length,
            });
            if (esc.escalate) {
              console.log(`[model] ${ctx.shop} Haiku→Sonnet escalation reason=${esc.reason}`);
              const { buf: sonnetBuf, r: sonnetResult } = await runBuffered(sonnetModel);
              addUsage(sonnetResult.totalUsage, haikuResult.totalUsage); // bill both attempts
              result = sonnetResult; chosenBuf = sonnetBuf;
            } else {
              result = haikuResult; chosenBuf = haikuBuf;
            }
          } else {
            const { buf, r } = await runBuffered(model);
            result = r; chosenBuf = buf;
          }

          // Reactive Sonnet→Opus escalation: a fact-validator caught the
          // model reasoning wrong this turn (denied a real category,
          // hallucinated a definition, or produced text wiped to a
          // generic fallback). Re-run on Opus and prefer its answer.
          if (opusEscalationEnabled && result.model !== opusModel) {
            const esc = sonnetEscalationSignal({
              alreadyTopTier: result.model === opusModel,
              signals: result.qualitySignals || {},
            });
            if (esc.escalate) {
              console.log(`[model] ${ctx.shop} ${result.model}→Opus escalation reason=${esc.reason}`);
              const { buf: opusBuf, r: opusResult } = await runBuffered(opusModel);
              addUsage(opusResult.totalUsage, result.totalUsage); // bill both attempts
              result = opusResult; chosenBuf = opusBuf;
            }
          }

          // Flush the chosen attempt to the real controller (single emit).
          for (const c of chosenBuf) controller.enqueue(c);

          const lastText = result.fullResponseText || "";
          const hasChoiceButtons = /<<[^<>]+>>/.test(lastText);

          // Suppress follow-up suggestions when a recommend_* tool fired
          // this turn. The recommender resolves to ONE specific SKU based
          // on the customer's collected attributes; "alternative" follow-
          // ups ("in other styles?", "different color?") imply variants
          // the resolver may not have, leading to dead-ends. Customer
          // already got their definitive answer — don't dilute with
          // questions we can't reliably fulfill.
          const fuUsage = await emitFollowUpSuggestions({
            lastText,
            recommenderInvoked: result.recommenderInvokedThisTurn === true,
            cardsCount: (result.turnResult?.products?.length
              || result.finalProductCards?.length
              || 0),
          });
          if (fuUsage) addUsage(result.totalUsage, fuUsage);

          controller.enqueue(encoder.encode(sseChunk({ type: "done" })));

          const u = result.totalUsage;
          if (u.cache_creation_input_tokens || u.cache_read_input_tokens) {
            console.log(`[cache] created=${u.cache_creation_input_tokens} read=${u.cache_read_input_tokens} input=${u.input_tokens}`);
          }

          if (!internal) recordChatUsage({
            shop: shop,
            model: result.model,
            usage: result.totalUsage,
            toolCalls: result.toolCallCount,
            embeddingTokens: ctx.embeddingUsage.tokens,
            embeddingCostUsd: computeEmbeddingCost(ctx.embeddingUsage.provider, ctx.embeddingUsage.tokens),
          }).catch((err) => console.error("[chat] usage log error:", err?.message));
        } catch (err) {
          console.error("[chat] stream error:", err?.message || err);
          // classifyAnthropicError tells us if the error was retryable
          // (we already retried up to 2x in withAnthropicRetry — if we
          // got here, retries were exhausted) and gives a stable kind
          // for the customer-facing message.
          const classified = classifyAnthropicError(err);
          if (classified.kind === "rate_limit") {
            incrementRateLimitHits(shop).catch(() => {});
          }
          const userMsg = customerFacingFailureMessage(classified.kind);
          controller.enqueue(
            encoder.encode(sseChunk({ type: "error", message: userMsg })),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
}
