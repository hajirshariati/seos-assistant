import Anthropic from "@anthropic-ai/sdk";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFilesWithContent, incrementRateLimitHits } from "../models/ShopConfig.server";
import { getAttributeMappings } from "../models/AttributeMapping.server";
import { getCatalogCategories, getAllCatalogCategories, getCategoryGenderAvailability, getCategoryAttributeCoverage } from "../models/Product.server";
import { getActiveCampaigns, formatCampaignsForCS } from "../models/Campaign.server";
import { buildSystemPrompt } from "../lib/chat-prompt.server";
import { planTurn, buildTurnPlanPromptBlock } from "../lib/turn-plan.server";
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
import { maybeRunOrthoticFlow } from "../lib/orthotic-flow-gate.server";
import { classifyOrthoticTurn, shouldRunOrthoticClassifier } from "../lib/orthotic-classifier.server";
import { resolveCatalogTurn, buildResolverStatePromptBlock, extractUserConstraints, detectSpecificProduct, mentionsCatalogProductFamily } from "../lib/catalog-resolver.server";
import { getCatalogFacetIndex } from "../lib/catalog-facts.server";
import { catalogScopedNavigationQuestionVerdict, umbrellaCategoryTermsFromGroups } from "../lib/catalog-matcher.server";
import { buildSessionMemory, detectClarifyingQuestionType, memorySummary, buildSessionMemoryPromptBlock } from "../lib/session-memory.server";
import {
  SKU_PATTERN,
  createTurnResult,
  dropSiblingCards,
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
  dropNonShoppableItems,
  detectComparisonIntent,
  resolveFocusedCardByName,
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
} from "../lib/emit-finalize.server";
import { detectConversationGoal, ANCHOR_GOALS } from "../lib/turn-intent.server";
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
  const ensuredCards = await ensureProductTurnCards({
    ctx,
    allProductPool,
    dispatchTool,
    extractProductCards: (n, r) => extractProductCards(n, r, ctx),
    searchInput: scopedProductSearchInput(ctx),
    shouldAttach: productTurnWantsCards,
    allowRelaxedNoMatch: isCompoundPolicyProductQuestion(ctx.latestUserMessage),
    reason: "pre-display",
  });
  if (ensuredCards.searchAttempted) productSearchAttempted = true;
  let pool = ensuredCards.products;
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

  if (!supportCTA && genericCTA) {
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

  const hasChoiceButtonsForCards = hasChoiceButtons(fullResponseText);
  let suppressCardsForChips = false;
  if (hasChoiceButtonsForCards && pool.length > 0) {
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

  if (pool.length > 0 && fullResponseText && !suppressCardsForChips) {
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
          const reason = !c.visualizeLookEnabled ? "feature disabled in Settings"
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
      const collection = extractCollectionCTA(fullResponseText);
      if (collection.cta) {
        outboundLinks.push({ url: collection.cta.url, label: collection.cta.label });
        controller.enqueue(encoder.encode(sseChunk({
          type: "link",
          url: collection.cta.url,
          label: collection.cta.label,
        })));
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
  const turnWarnings = validateTurnResult(turnResult);
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
          console.log(`[rag] retrieved ${retrievedChunks?.length || 0} chunk(s) for query="${ragQuery.slice(0, 60)}"`);
        } catch (err) {
          console.error("[rag] retrieval failed, falling back to full dump:", err?.message || err);
          retrievedChunks = null;
        }
      }
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
      if (isFactFollowup) {
        // Bind to the product the customer named — by full title or by
        // its short model-name token ("danika" → "Danika Arch Support
        // Sneaker"). Falls back to the sole card when only one is shown.
        const named = resolveFocusedCardByName(latestUserMessage, priorProductCards);
        focusProduct = named || (priorProductCards.length === 1 ? priorProductCards[0] : null);
        if (focusProduct) {
          console.log(`[chat] focus-product anchor: "${focusProduct.title}" (goal=${convGoal?.type || "fact-followup"})`);
        }
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

    // ── Central TurnPlan ──────────────────────────────────────────────
    // One front-of-turn brain classifies the turn into a single workflow
    // and emits the plan (search required, clarification allowed, product
    // display, gender) that governs it. The compact plan block is injected
    // into the volatile prompt suffix so the LLM-owns-turn model follows it,
    // replacing the scattered per-screenshot gates. Pure + unit-tested
    // (scripts/eval-turn-plan.mjs); see app/lib/turn-plan.server.js.
    let turnPlan = null;
    try {
      let planNamedProduct = false;
      try {
        planNamedProduct = await mentionsCatalogProductFamily(shop, latestUserMessage);
      } catch { /* family lookup best-effort; default false */ }
      turnPlan = planTurn({
        message: latestUserMessage,
        attrs: { gender: sessionGender || undefined },
        namedProduct: planNamedProduct || Boolean(focusProduct),
        focusProduct: focusProduct ? (focusProduct.handle || focusProduct.title || true) : null,
        hasPriorCards: Array.isArray(priorProductCards) && priorProductCards.length > 0,
        primaryGender: "women",
      });
      const planBlock = buildTurnPlanPromptBlock(turnPlan);
      if (planBlock) {
        systemPrompt += "\n\n" + planBlock + "\n";
        console.log(
          `[chat] turn-plan workflow=${turnPlan.workflow} search=${turnPlan.searchRequired} ` +
          `clarify=${turnPlan.clarificationAllowed} display=${turnPlan.productDisplayPolicy} ` +
          `gender=${turnPlan.gender || "-"} named=${planNamedProduct}`,
        );
      }
    } catch (err) {
      console.error("[chat] turn-plan failed (non-fatal):", err?.message || err);
    }

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

          if (shouldSoftBrowseRefine(body.message, history)) {
            routerLog.finalPath = "soft_browse_refine";
            console.log(`[router] ${ctx.shop} ${routerLog.classifier}`);
            console.log(`[router] ${ctx.shop} ${routerLog.resolver || "resolver=skip"}`);
            console.log(`[router] ${ctx.shop} ${routerLog.orthoticGate || "handled=false case=pre-gate-soft-browse"}`);
            console.log(`[router] ${ctx.shop} final_path=${routerLog.finalPath}`);
            await emitSoftGenderGateBrowse({ ctx, controller, encoder });
            return;
          }

          // STAGE 3: orthotic gate decision (now receives resolverState)
          let gateHandled = false;
          if (orthoticTree) {
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
                return;
              }
              if (gate?.softGenderGateEscape) {
                routerLog.finalPath = "soft_gender_browse";
                console.log(`[router] ${ctx.shop} ${routerLog.classifier}`);
                console.log(`[router] ${ctx.shop} ${routerLog.resolver || "resolver=skip"}`);
                console.log(`[router] ${ctx.shop} ${routerLog.orthoticGate}`);
                console.log(`[router] ${ctx.shop} final_path=${routerLog.finalPath}`);
                await emitSoftGenderGateBrowse({ ctx, controller, encoder });
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
            const needsStrongModel =
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
            const runLoopOnce = async ({ messages: msgs, attempt = 0, rewriteOnly = false }) => {
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
                ctx: { ...ctx },
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
          const variantFactResult = await runVariantFactDispatch({
            ctx, controller, encoder,
          });
          if (variantFactResult && variantFactResult.handled) {
            console.log(`[router] ${ctx.shop} final_path=variant_fact_engine`);
            console.log(
              `[variant-facts] handled shop=${ctx.shop} ` +
                `usedSearch=${variantFactResult.diagnostics?.usedSearch ? "yes" : "no"} ` +
                `colors=${variantFactResult.diagnostics?.colors || 0} ` +
                `otherColors=${variantFactResult.diagnostics?.otherColors || 0} ` +
                `textLen=${variantFactResult.answerText?.length || 0}`,
            );
            return;
          }

          const compoundPolicyProduct = isCompoundPolicyProductQuestion(body.message);
          const directProductFact = isDirectProductFactQuestion(body.message);
          const orthoticRecommendationIntent = isOrthoticRecommendationIntent(body.message);

          const policyResult = compoundPolicyProduct
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

          const resolverNoMatchResult = await runResolverNoMatchDispatch({
            ctx, controller, encoder,
          });
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
            return; // exact catalog no-match emitted text/products(empty)/done.
          }

          const engineResult = (compoundPolicyProduct || directProductFact || orthoticRecommendationIntent)
            ? { declined: true, diagnostics: { rungs: [
                compoundPolicyProduct ? "declined:compound_policy_product" : null,
                directProductFact ? "declined:direct_product_fact" : null,
                orthoticRecommendationIntent ? "declined:orthotic_recommendation_intent" : null,
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
