import Anthropic from "@anthropic-ai/sdk";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFilesWithContent, incrementRateLimitHits } from "../models/ShopConfig.server";
import { getAttributeMappings } from "../models/AttributeMapping.server";
import { getCatalogCategories, getAllCatalogCategories, getCategoryGenderAvailability, getCategoryAttributeCoverage } from "../models/Product.server";
import { getActiveCampaigns, formatCampaignsForCS } from "../models/Campaign.server";
import { buildSystemPrompt } from "../lib/chat-prompt.server";
import { retrieveRelevantChunks } from "../lib/knowledge-chunks.server";
import { filterForbiddenCategoryChips, filterContradictingGenderChips } from "../lib/chip-filter.server";
import { analyzeCategoryIntent, cardMatchesActiveGroup, textIntentDivergesFromGroup, matchingGroupsForText } from "../lib/category-intent.server";
import { extractAnsweredChoices } from "../lib/conversation-memory.server";
import {
  detectGenderFromHistory as _detectGenderFromHistory,
  reconcileSessionGender,
  stripBannedNarration,
  stripMetaNarration,
  looksLikeProductPitch,
  looksLikeDefinitionalHallucination,
  hasChoiceButtons,
  dedupeConsecutiveSentences,
  isSingularPrescriptive,
  hasPluralIntroFraming,
  detectConditionOrOccasion,
  containsAvailabilityDenial,
  stripLineupPromiseSentences,
  isCapabilityCheckAboutPriorProducts,
  reflowInlineList,
  truncateAtWordBoundary,
  isBrandOrInfoQuestion,
} from "../lib/chat-helpers.server";
import { TOOLS, executeTool, extractProductCards, CUSTOMER_ORDERS_TOOL, FIT_PREDICTOR_TOOL, detectLatestGender } from "../lib/chat-tools.server";
import { rewriteToolCall } from "../lib/chat-tool-rewrite.server";
import { withAnthropicRetry, classifyAnthropicError, customerFacingFailureMessage } from "../lib/anthropic-resilience.server";
import { fetchCustomerContext } from "../lib/customer-context.server";
import { fetchKlaviyoEnrichment } from "../lib/klaviyo-enrichment.server";
import { fetchYotpoLoyalty } from "../lib/yotpo-loyalty.server";
import { buildRecommenderTools } from "../lib/recommender-tools.server";
import { maybeRunOrthoticFlow } from "../lib/orthotic-flow-gate.server";
import { classifyOrthoticTurn } from "../lib/orthotic-classifier.server";
import { resolveCatalogTurn, buildResolverStatePromptBlock, extractUserConstraints, detectSpecificProduct } from "../lib/catalog-resolver.server";
import { buildSessionMemory, detectClarifyingQuestionType, memorySummary, buildSessionMemoryPromptBlock } from "../lib/session-memory.server";
import {
  SKU_PATTERN,
  createTurnResult,
  detectFalseCategoryDenial,
  detectFalseGenderCategoryAffirmation,
  dropSiblingCards,
  buildCodeOwnedProductListingText,
  buildCodeOwnedComparisonText,
  buildSoftBrowseFallbackText,
  ensureProductTurnCards,
  extractCollectionCTA,
  extractGenericCTA,
  extractOrphanSkus,
  extractSupportCTA,
  currentCatalogScopeFromContext,
  ensureCompleteCustomerText,
  prepareProductCardsForTurn,
  repairProductTurnAssembly,
  resolveProductTurnLink,
  scoreCardAgainstText,
  skusFromCardText,
  stripMissingSkus,
  titleStyleFamily,
  validateTurnResult,
} from "../lib/response-contract.server";
import {
  detectSingularIntent,
  detectComparisonIntent,
  detectAiPivotPhrasing,
  detectRejectedCategories,
  stripRejectedCategoryChips,
  stripToolCallSyntax,
  detectStockClaim,
  stripStockClaim,
  isYesNoQuestion,
  isYesNoAnswer,
  detectUserSignupIntent,
  detectAiSignupMention,
  scrubRoleMarkers,
  scrubToolCallLeaks,
  detectBroadNeed,
  detectAiNoMatchPhrasing,
  looksLikeClarifyingQuestion,
  suggestionContradictsGender,
  isUnanswerableSuggestion,
  haikuEscalationSignal,
  sonnetEscalationSignal,
  stripUnsafeInlineChips,
  detectFootwearOverElicitation,
  stripInternalLeaks,
  scrubInternalEnums,
  resolverPromisedRecommendation,
  dropNonFootwearWhenFootwearIntent,
} from "../lib/chat-postprocessing";
import prisma from "../db.server";
import { recordChatUsage, getTodayMessageCount } from "../models/ChatUsage.server";
import { canSendMessage } from "../lib/billing.server";

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
  const rewritten = rewriteToolCall({ name, input }, ctx);
  return await executeTool(rewritten.name, rewritten.input, ctx);
}

// Guard against denial-recovery firing on policy/discount/return
// questions where the AI's "we don't have/offer X" is a legitimate
// answer about merchant policy, NOT a hallucinated product
// availability denial. Without this guard, the customer asks
// "Can I get a discount if I buy both?" → AI politely answers
// "I don't have info on bundle discounts" → AVAILABILITY_DENIAL_RE
// matches "don't have" → recovery forces a product search and
// shows random orthotic cards under a discount question.
const POLICY_QUESTION_RE = /\b(discount|coupon|promo(?:tion)?|refund|return|exchange|warranty|guarantee|policy|polic(?:ies|y)|ship(?:ping|ment)?|deliver(?:y|ies)?|bundle|payment|installment|hours|track(?:ing)?|order (?:status|number|history)|account|sign\s*in|log\s*in|coupon|support\s+team|contact\s+(?:you|your|support|us|customer)|customer\s+service|gov\s*x|teacher\s+discount|military\s+discount|first\s+responder|nurse\s+discount|student\s+discount|senior\s+discount)\b/i;
function isPolicyOrServiceQuestion(text) {
  return Boolean(text) && POLICY_QUESTION_RE.test(text);
}

const PRODUCT_SHOPPING_NOUN_RE = /\b(shoes?|footwear|sneakers?|sandals?|boots?|loafers?|clogs?|wedges?|heels?|orthotics?|insoles?|footbeds?|inserts?|slippers?|oxfords?|mary\s+janes?|slip[-\s]?ons?|accessor(?:y|ies)|slides?|flats?|mules?|styles?|pairs?)\b/i;
const SHOPPING_ACTION_RE = /\b(show|find|have|carry|sell|stock|looking\s+for|look\s+for|need|want|recommend|browse|shop|any|options?|styles?)\b/i;
const COMPOUND_JOINER_RE = /\b(?:and|also|plus|while|then|too|as\s+well)\b|[,;]\s*(?:and|also|plus)?\s*/i;

function hasCompoundProductAsk(text) {
  const value = String(text || "");
  if (!PRODUCT_SHOPPING_NOUN_RE.test(value)) return false;
  if (SHOPPING_ACTION_RE.test(value)) return true;
  return /\b(?:and|also|plus|too|as\s+well)\b[^?!.]{0,80}\b(shoes?|footwear|sneakers?|sandals?|boots?|loafers?|clogs?|wedges?|heels?|orthotics?|insoles?|slippers?|styles?|pairs?)\b/i.test(value);
}

function isCompoundPolicyProductQuestion(text) {
  if (!isPolicyOrServiceQuestion(text)) return false;
  const value = String(text || "");
  if (!hasCompoundProductAsk(value)) return false;
  return COMPOUND_JOINER_RE.test(value);
}

function scopedProductSearchInput(ctx = {}) {
  const latestMsg = String(ctx.latestUserMessage || "");
  const scope = currentCatalogScopeFromContext(ctx);
  const latest = extractUserConstraints(latestMsg);
  const gender = scope.gender || latest.gender;
  const category = scope.category || latest.category;
  const color = scope.color || latest.color;
  const size = scope.size || latest.size;
  const width = scope.width || latest.width;
  const condition = scope.condition || latest.condition;
  const filters = {};
  if (gender) filters.gender = gender;
  if (category) filters.category = category;
  if (color) filters.color = color;
  if (size) filters.size = size;
  if (width) filters.width = width;

  const query = [color, condition, category]
    .filter(Boolean)
    .join(" ")
    .trim() || latestMsg.slice(0, 160).trim() || "shoes";

  return {
    input: { query, filters, limit: 6 },
    scope: { gender, category, color, size, width, condition },
  };
}

function shouldAttachProductCardsForTurn({ text, ctx, recommenderAskedForMoreInfo }) {
  const latest = ctx?.latestUserMessage || "";
  const compound = isCompoundPolicyProductQuestion(latest);
  const latestIsPolicyOnly = isPolicyOrServiceQuestion(latest) && !compound;
  if (latestIsPolicyOnly || recommenderAskedForMoreInfo) return false;
  if (resolverPromisedRecommendation(ctx?.resolverState)) return true;
  if (compound) return true;
  if (!text) return false;
  if (looksLikeClarifyingQuestion(text)) return false;
  return looksLikeProductPitch(text);
}

function compoundPolicyFallbackText(latestMessage = "") {
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
  if (/\b(contact|support|customer service|account|log\s*in|sign\s*in)\b/i.test(latest)) {
    return "For account or support questions, use the support link to contact Aetrex customer service.";
  }
  return "For the service question, the support page has the current Aetrex details.";
}

function policyOnlyFallbackText(latestMessage = "") {
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
  if (/\b(contact|support|customer service|account|log\s*in|sign\s*in)\b/i.test(latest)) {
    return "Aetrex support can help with account and order questions. Use the support link below to contact customer service.";
  }
  return "";
}

function compoundProductFallbackText(ctx = {}) {
  const { scope } = scopedProductSearchInput(ctx);
  const category = scope.category ? String(scope.category).replace(/-/g, " ") : "styles";
  const gender = scope.gender === "men" ? "men's " : scope.gender === "women" ? "women's " : "";
  return `I also found the closest ${gender}${category} below.`;
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
  if (!/\b(?:cheap|cheaper|under|below|less\s+than|sale|deals?|discount)\b/i.test(latest)) return false;
  const previous = lastAssistantContent(history);
  return /\bnarrow by men's, women's, style, color, or price\b/i.test(previous) ||
    /\bhere are (?:a few|popular|sale|comfort-focused|styles under \$\d+)/i.test(previous);
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
    return filterExcluded(extractProductCards("search_products", result)).slice(0, cap);
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
      filterExcluded(extractProductCards("search_products", women)),
      filterExcluded(extractProductCards("search_products", men)),
    ],
    cap,
  );
  if (mixed.length > 0) return mixed;

  const fallback = await dispatchTool("search_products", searchInput, ctx);
  return filterExcluded(extractProductCards("search_products", fallback)).slice(0, cap);
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

async function runAgenticLoop({ anthropic, model, systemPrompt, messages, ctx, controller, encoder, promptCaching, tools }) {
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


  const system = promptCaching
    ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
    : systemPrompt;

  const activeTools = tools || TOOLS;

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
      const cards = extractProductCards(u.name, r);
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
          payload._display = "Product card is shown automatically. Do NOT list products with links or repeat the SKU/handle in your text. Write a brief 1-2 sentence summary explaining why this fits.";
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
        const newCards = extractProductCards("lookup_sku", recovery);
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

  if (productSearchAttempted && allProductPool.size > 0 && allProductPool.size <= 2) {
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
  const currentClarifyingType = detectClarifyingQuestionType(fullResponseText);
  const lastClarifyingType = ctx.sessionMemory?.lastClarifyingQuestion?.type || null;
  if (currentClarifyingType && currentClarifyingType === lastClarifyingType && allProductPool.size === 0) {
    try {
      const scoped = scopedProductSearchInput(ctx);
      const hasScope = !!(scoped.scope.gender || scoped.scope.category || scoped.scope.color);
      const input = hasScope ? scoped.input : softGenderBrowseSearchInput(ctx.latestUserMessage || "");
      const repeatIndex = priorBrowseCount(ctx.messages);
      const repeated = repeatIndex > 0;
      const excludeHandles = repeated && !hasScope ? priorlyShownHandles(ctx) : null;
      const cards = hasScope
        ? extractProductCards("search_products", await dispatchTool("search_products", input, ctx))
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
  });
  const ensuredCards = await ensureProductTurnCards({
    ctx,
    allProductPool,
    dispatchTool,
    extractProductCards,
    searchInput: scopedProductSearchInput(ctx),
    shouldAttach: productTurnWantsCards,
    reason: "pre-display",
  });
  if (ensuredCards.searchAttempted) productSearchAttempted = true;
  let pool = ensuredCards.products;
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
  const latestComparisonUsesPriorCards =
    detectComparisonIntent(ctx.latestUserMessage) &&
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

  if (fullResponseText) {
    const result = stripInternalLeaks(fullResponseText);
    if (result.changed) {
      console.log(`[chat] stripped internal language leak${result.replaced ? " (whole-reply fallback)" : ""}`);
      fullResponseText = result.text;
    }
  }

  if (fullResponseText) {
    const scrubbed = scrubInternalEnums(fullResponseText);
    if (scrubbed.changed) {
      console.log(`[chat] scrubbed orthotic internal enum token(s) before emit`);
      fullResponseText = scrubbed.text;
    }
  }

  if (fullResponseText) {
    const stripped = stripBannedNarration(fullResponseText);
    if (stripped !== fullResponseText.trim()) {
      console.log(`[chat] stripped banned narration`);
      fullResponseText = stripped;
    }
  }

  if (fullResponseText) {
    const beforeMeta = fullResponseText;
    const stripped = stripMetaNarration(fullResponseText);
    if (stripped !== beforeMeta.trim()) {
      console.log(`[chat] stripped meta-narration`);
      fullResponseText = stripped;
    }
  }

  if (fullResponseText) {
    const beforeDedupe = fullResponseText;
    const deduped = dedupeConsecutiveSentences(fullResponseText);
    if (deduped !== beforeDedupe.trim()) {
      console.log(`[chat] deduped repeated sentences`);
      fullResponseText = deduped;
    }
  }

  if (fullResponseText) {
    const before = fullResponseText;
    const reflowed = reflowInlineList(fullResponseText);
    if (reflowed !== before) {
      console.log(`[chat] reflowed inline list into bullets`);
      fullResponseText = reflowed;
    }
  }

  const PRODUCT_REPLY_HARD_CAP = 300;
  if (
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
      console.log(`[chat] response-length cap: ${fullResponseText.length} → ${truncated.length} chars (pool=${pool.length})`);
      fullResponseText = truncated;
    }
  }

  if (
    pool.length === 0 &&
    looksLikeProductPitch(fullResponseText) &&
    !looksLikeClarifyingQuestion(fullResponseText) &&
    !recommenderAskedForMoreInfo &&
    !isBrandOrInfoQuestion(ctx.latestUserMessage) &&
    !resolverPromisedRecommendation(ctx.resolverState)
  ) {
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
      fullResponseText = pool.length > 0
        ? `Take a look — here are some ${deniedCat.toLowerCase()} from the catalog.`
        : `We do carry ${deniedCat.toLowerCase()} — could you share a bit more (gender, style, occasion)? I can pull up a few for you.`;
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
  } else if (!fullResponseText && pool.length > 0) {
    // Strips wiped the entire text (e.g. AI's only output was
    // "Let me look that up for you!") but a search returned products.
    // Without a fallback we'd ship an empty bubble above the cards.
    console.log(`[chat] empty-text repair: text wiped by strips, pool=${pool.length}`);
    qualitySignals.emptyAfterStrips = true;
    fullResponseText = "Take a look — these are the closest matches I've got.";
  }

  if (
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
      console.log("[chat] policy-contract: replaced generic/missing policy reply with deterministic support answer");
    }
  }

  if (isCompoundPolicyProductQuestion(ctx.latestUserMessage) && fullResponseText) {
    const additions = [];
    const policyFallback = compoundPolicyFallbackText(ctx.latestUserMessage);
    if (policyFallback && !/\b(return|returns|refund|exchange|30\s+days?|unworn|shipping|delivery|warranty|guarantee|discount|coupon|promo|code|sale|rewards?|loyalty|points?|vip|support|customer service|order|tracking)\b/i.test(fullResponseText)) {
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
    const filtered = filterForbiddenCategoryChips(fullResponseText, ctx.catalogCategories, ctx.fullCatalogCategories, extraChipAllow);
    if (filtered.stripped.length > 0) {
      console.log(`[chat] ${ctx.shop} stripped off-catalog chips:`, filtered.stripped, "allowed:", ctx.catalogCategories, extraChipAllow.length > 0 ? `extra(via goesInsideOf):${extraChipAllow.join(",")}` : "");
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
  if (fullResponseText && /(?:<\/?(?:function_calls|invoke|antml|parameter)|\b(?:search_products|get_product_details|lookup_sku|find_similar_products|recommend_[a-z_]+)\s*\{)/i.test(fullResponseText)) {
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
  if (ctx.categoryGenderMap) {
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
      fullResponseText = "Take a look — these are the closest matches I've got.";
      console.log(`[chat] ${ctx.shop} empty-text repair (pool=${pool.length}): substituted generic pitch`);
    } else if (productSearchAttempted) {
      fullResponseText = "I couldn't find a match for that — happy to try a different angle if you can tell me more.";
      console.log(`[chat] ${ctx.shop} empty-text repair (search-attempted, no pool): substituted clarify-ask`);
    } else {
      fullResponseText = "Could you tell me a bit more about what you're looking for?";
      console.log(`[chat] ${ctx.shop} empty-text repair (no search): substituted clarify-ask`);
    }
  }

  if (pool.length > 0 && fullResponseText) {
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

  if (pool.length > 0 && fullResponseText && ctx.latestUserMessage) {
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

  if (pool.length > 0 && fullResponseText && ctx.latestUserMessage) {
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

  if (pool.length >= 2 && ctx.latestUserMessage && detectComparisonIntent(ctx.latestUserMessage)) {
    const comparison = buildCodeOwnedComparisonText({
      text: fullResponseText,
      cards: pool,
    });
    if (comparison.changed) {
      const before = fullResponseText;
      fullResponseText = comparison.text;
      console.log(
        `[chat] response-contract: code-owned comparison ` +
          `(${before.length}→${fullResponseText.length} chars, pool=${pool.length}, reason=${comparison.reason})`,
      );
    }
  }

  if (pool.length > 0 && fullResponseText) {
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

  if (pool.length > 0 && fullResponseText) {
    if (!detectComparisonIntent(ctx.latestUserMessage)) {
      const listing = buildCodeOwnedProductListingText({
        text: fullResponseText,
        cards: pool,
        ctx,
        recommenderInvoked: recommenderInvokedThisTurn,
      });
      if (listing.changed) {
        const before = fullResponseText;
        const serviceAnswer = isCompoundPolicyProductQuestion(ctx.latestUserMessage)
          ? compoundPolicyFallbackText(ctx.latestUserMessage)
          : "";
        fullResponseText = serviceAnswer
          ? `${serviceAnswer} ${listing.text}`
          : listing.text;
        console.log(
          `[chat] response-contract: code-owned product listing ` +
            `(${before.length}→${fullResponseText.length} chars, pool=${pool.length}, reason=${listing.reason})`,
        );
      }
    }
  }

  if (fullResponseText) {
    const inlineChips = stripUnsafeInlineChips(fullResponseText, { hasProducts: pool.length > 0 });
    if (inlineChips.changed) {
      console.log(`[chat] stripped unsafe inline chip(s) before emit (${inlineChips.reason})`);
      fullResponseText = inlineChips.text;
    }
  }

  if (fullResponseText) {
    const fallback = pool.length > 0
      ? "Here are the matching styles I found."
      : (looksLikeClarifyingQuestion(fullResponseText)
        ? "Could you tell me a bit more about what you're looking for?"
        : "I can help with that.");
    const coherent = ensureCompleteCustomerText({ text: fullResponseText, fallback });
    if (coherent.changed) {
      console.log(`[chat] response-contract: repaired incomplete sentence (${coherent.reason})`);
      fullResponseText = coherent.text;
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

  controller.enqueue(encoder.encode(sseChunk({
    type: "text",
    text: fullResponseText
  })));

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
          // Fail-open: filter wiped every card. Stale group lock; better
          // to render the search results than ship an empty bubble that
          // the customer reads as "AI claimed a recommendation but no
          // card". Same fail-open pattern as the search layer.
          console.log(`[chat] product-card group guard: WIPED ALL ${beforeGroup} for group=${ctx.activeCategoryGroup.name || "-"} → falling back to unfiltered`);
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

    if (detectComparisonIntent(latestMsgForIntent)) {
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
    } else if (
      (!effectiveSaysNoMatch || isCompoundPolicyProductQuestion(ctx.latestUserMessage)) &&
      pool.length > 0 &&
      shouldAttachProductCardsForTurn({ text: fullResponseText, ctx, recommenderAskedForMoreInfo })
    ) {
      // Last display-boundary invariant: a scoped product pool plus
      // product-presenting text must never degrade to a text-only turn
      // because a late scorer/narrower found no confident subset. At
      // this point the pool has already passed the response contract's
      // scope filter, so showing the top scoped cards is safer than
      // leaving the customer with "Here are..." and no cards.
      const fallbackCards = pool.slice(0, cardCap);
      const { products: deduped, categoryCounts, genderCounts } = prepareProductCardsForTurn(fallbackCards);
      if (deduped.length > 0) {
        console.log(`[chat] display-boundary: scorer produced zero cards; emitting ${deduped.length} scoped fallback card(s)`);
        finalProductCards = deduped;
        controller.enqueue(encoder.encode(sseChunk({
          type: "products",
          products: deduped,
        })));

        const productLink = resolveProductTurnLink({ categoryCounts, genderCounts, ctx });
        if (productLink.link) {
          outboundLinks.push(productLink.link);
          controller.enqueue(encoder.encode(sseChunk({
            type: "link",
            url: productLink.link.url,
            label: productLink.link.label,
          })));
        }
      }
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
  };
}

export const loader = async () => {
  return Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });
};

export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.public.appProxy(request);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const rate = checkIpShopRate(session.shop, clientIp(request));
    if (!rate.ok) {
      return Response.json(
        { error: "rate_limited", retryAfter: rate.retryAfter },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter) } },
      );
    }

    const config = await getShopConfig(session.shop);
    if (!config.anthropicApiKey) {
      return Response.json(
        { error: "AI engine API key not configured. Set it in the app admin under Settings." },
        { status: 503 },
      );
    }

    const quota = await canSendMessage(session.shop);
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
    if (config.dailyCapEnabled && config.dailyCapMessages > 0) {
      const todayCount = await getTodayMessageCount(session.shop);
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

    const priorProductCards = extractPriorProductCards(body.history);
    const allPriorProductCards = extractAllPriorProductCards(body.history);
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
    let sessionGender = latestPivotedGender || historicalSessionGender;
    if (latestPivotedGender && latestPivotedGender !== historicalSessionGender) {
      console.log(
        `[chat] gender-pivot: history=${historicalSessionGender || "-"} → latest=${latestPivotedGender} ` +
          `(triggered by "${latestUserMessage.slice(0, 60)}")`,
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

    let [knowledge, attrMappings, catalogProductTypes, allCatalogCategories, categoryGenderMap, categoryAttributeCoverage, activeCampaigns] = await Promise.all([
      getKnowledgeFilesWithContent(session.shop),
      getAttributeMappings(session.shop),
      getCatalogCategories(session.shop, { gender: sessionGender }),
      getAllCatalogCategories(session.shop),
      getCategoryGenderAvailability(session.shop),
      getCategoryAttributeCoverage(session.shop),
      getActiveCampaigns(session.shop),
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
        `[chat] ${session.shop} suppressed categories from allow-list: ` +
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

    console.log(`[chat] ${session.shop} gender=${sessionGender || "any"} scoped-categories=${catalogProductTypes.length} full-catalog-categories=${allCatalogCategories.length}${groupFilterApplied ? ` group=${groupFilterApplied}` : ""}${categoryIntent.contextGroup ? ` contextGroup=${categoryIntent.contextGroup.name}` : ""}${categoryIntent.ambiguous ? " group=ambiguous" : ""}`);
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

    // session.accessToken from app proxy may be an online/proxy token; for
    // Admin API calls we need the offline token. Fall back to the Session
    // table if the proxy session's token is missing.
    let accessToken = session.accessToken;
    if (!accessToken) {
      const offline = await prisma.session.findFirst({
        where: { shop: session.shop, isOnline: false },
        orderBy: { expires: "desc" },
      });
      accessToken = offline?.accessToken || null;
    }

    let customerContext = null;
    if (loggedInCustomerId && config.vipModeEnabled === true && accessToken) {
      customerContext = await fetchCustomerContext({
        shop: session.shop,
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
    let retrievedChunks = null;
    if (config.knowledgeRagEnabled === true) {
      const ragQuery = String(body.message || "").trim();
      if (ragQuery) {
        try {
          retrievedChunks = await retrieveRelevantChunks(prisma, {
            shop: session.shop,
            query: ragQuery,
            config,
            limit: 5,
          });
          console.log(`[rag] retrieved ${retrievedChunks?.length || 0} chunk(s) for query="${ragQuery.slice(0, 60)}"`);
        } catch (err) {
          console.error("[rag] retrieval failed, falling back to full dump:", err?.message || err);
          retrievedChunks = null;
        }
      }
    }

    let systemPrompt = buildSystemPrompt({
      config,
      knowledge,
      retrievedChunks,
      shop: session.shop,
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
    });
    // Kids-coverage honesty. When the customer is shopping for a child
    // but the gender-scoped catalog carries NO kids' footwear (only
    // accessories / orthotic insoles are tagged kid-eligible), the AI
    // must say so plainly instead of steering them to kids accessories
    // as if that were the ask. Production failure: the bot offered
    // "kids accessories / orthotics" for a child with no kids' shoes in
    // the catalog, which reads as a bait-and-switch. Data-driven —
    // derived from the live gender-scoped category list, not a
    // hardcoded merchant assumption — so it self-disables the moment a
    // merchant adds kids' footwear.
    if (["kid", "kids", "boy", "girl"].includes(String(sessionGender || ""))) {
      const NON_FOOTWEAR = new Set([
        "accessories", "accessory", "orthotics", "orthotic",
        "insoles", "insole", "socks", "gift card", "gift cards",
      ]);
      const kidsFootwear = catalogProductTypes.filter(
        (c) => !NON_FOOTWEAR.has(String(c || "").toLowerCase().trim()),
      );
      if (kidsFootwear.length === 0) {
        console.log(`[chat] ${session.shop} kids-coverage: no kids footwear in catalog (scoped=${catalogProductTypes.join("|") || "none"}); injecting honesty note`);
        systemPrompt +=
          "\n\n=== Kids coverage (turn-scoped) ===\n" +
          "This store does NOT carry children's / kids' footwear (shoes). " +
          "If the customer is shopping for a child, tell them plainly and up front that the store doesn't carry kids' shoes. " +
          "Do NOT offer kids' shoes, and do NOT pivot to kids' accessories or orthotic insoles as if they were the request. " +
          "Only mention that kids' accessories or orthotic insoles exist if the customer explicitly asks about them; otherwise suggest the adult lines or checking back later.\n";
      }
    }
    if (isCompoundPolicyProductQuestion(body.message)) {
      systemPrompt +=
        "\n\n=== Compound request handling (turn-scoped) ===\n" +
        "The latest customer message contains both a support/policy question and a product-shopping request. " +
        "Answer every distinct ask. Briefly answer the support/policy part, and also use search_products for the product-shopping part so product cards can render. " +
        "Do not treat the whole turn as support-only, and do not drop the product request.\n";
    }

    const model = chooseModel(config, String(body.message), history);

    const conversationText = messages.map((m) => typeof m.content === "string" ? m.content : "").join(" ");
    const userText = messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : "").join(" ");

    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const ctx = {
      shop: session.shop,
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
      latestUserMessage: String(body.message || ""),
      priorProductCards,
      allPriorProductCards,
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
            const built = await buildRecommenderTools(session.shop, {
              decisionTreeEnabled: config.decisionTreeEnabled === true,
            });
            if (built.tools.length > 0) {
              activeTools.push(...built.tools);
              recommenderTrees = built.trees;
              ctx.recommenderTrees = built.trees;
              console.log(
                `[recommender] registered ${built.tools.length} tool(s) for ${session.shop}: ` +
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

          // STAGE 1: classifier
          let classifiedIntent = null;
          const orthoticTree = (recommenderTrees || []).find((t) => t?.intent === "orthotic");
          if (orthoticTree) {
            try {
              classifiedIntent = await classifyOrthoticTurn({
                messages,
                anthropic,
                shop: session.shop,
              });
              ctx.classifiedIntent = classifiedIntent;
            } catch (clsErr) {
              console.error("[classifier] threw, falling through:", clsErr?.message || clsErr);
            }
          }
          routerLog.classifier = classifiedIntent
            ? `isOrthoticRequest=${!!classifiedIntent.isOrthoticRequest} attrs=${JSON.stringify(classifiedIntent.attributes || {})}`
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
                const handle = await detectSpecificProduct(session.shop, latestMsg);
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
              // Fill from the authoritative session gender when memory
              // has none, OR overwrite when the classifier just took
              // authority over a stale regex value — otherwise the
              // resolver would see the regex gender while the search
              // uses the classifier's (split-brain).
              if (sessionGender && (!sessionMemory.explicit.gender || genderAuthorityFromClassifier)) {
                sessionMemory.explicit.gender = sessionGender;
              }
              const resolverState = await resolveCatalogTurn({
                shop: session.shop,
                query: latestMsg,
                userConstraints,
                sessionMemory,
                messages,
              });
              ctx.sessionMemory = buildSessionMemory({
                messages,
                classifiedIntent,
                resolverState,
              });
              if (
                sessionGender &&
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

          // STAGE 3: orthotic gate decision (now receives resolverState)
          let gateHandled = false;
          if (orthoticTree) {
            try {
              const gate = await maybeRunOrthoticFlow({
                messages,
                tree: orthoticTree,
                shop: session.shop,
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

          if (shouldSoftBrowseRefine(body.message, history)) {
            routerLog.finalPath = "soft_browse_refine";
            console.log(`[router] ${ctx.shop} ${routerLog.classifier}`);
            console.log(`[router] ${ctx.shop} ${routerLog.resolver || "resolver=skip"}`);
            console.log(`[router] ${ctx.shop} ${routerLog.orthoticGate}`);
            console.log(`[router] ${ctx.shop} final_path=${routerLog.finalPath}`);
            await emitSoftGenderGateBrowse({ ctx, controller, encoder });
            return;
          }

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
          if (config.showFollowUps !== false && !hasChoiceButtons && !result.recommenderInvokedThisTurn) {
            try {
              const catalogLine = catalogProductTypes.length > 0
                ? `\n\nCATALOG ALLOW-LIST: this store sells ONLY these product categories: ${catalogProductTypes.join(", ")}. Any follow-up that names or implies a category MUST use one of these exact categories — it is FORBIDDEN to reference a category not on this list.`
                : "";
              const fuRes = await anthropic.messages.create({
                model: HAIKU_MODEL,
                max_tokens: 150,
                messages: [
                  {
                    role: "user",
                    content: `You are generating follow-up suggestions for "${ctx.shop}", a Shopify store. The store's AI assistant is named "${config.assistantName || "AI Shopping Assistant"}".\n\nCustomer asked: "${String(body.message).slice(0, 200)}"\nAssistant replied: "${lastText.slice(0, 300)}"${catalogLine}\n\nSuggest 2-3 brief follow-up questions the CUSTOMER would naturally ask next.\n\nRULES:\n- Questions MUST be directly relevant to the assistant's response. If the assistant asked the customer a question, suggest answers the customer might give — not unrelated questions.\n- Only reference products, styles, or details the assistant ACTUALLY mentioned. Never ask about things not yet discussed.\n- NEVER invent product categories the store might not carry. Only reference categories or product types that appeared in the conversation above OR appear in the CATALOG ALLOW-LIST above.\n- NEVER mention "brands" — this is a single-brand store.\n- NEVER ask about shoe size, availability, or pricing if no specific product has been shown yet.\n- NEVER suggest "Tell me more about [TechnologyName]", "What is [TM]", "How does [feature] work", or "Explain [material]" — those questions trigger AI hallucination because the catalog has marketing-level descriptions, not engineering specs. The AI cannot answer them accurately.\n- NEVER reference a trademarked or branded technology name (anything with TM, ®, ™, or a TitleCase product-tech term like UltraSKY, OrthoLite, etc.) UNLESS that exact term appeared verbatim in the assistant's reply above. Even then, prefer pivot questions over tech deep-dives.\n- NEVER ask about specific specs or measurements (heel height, stack height, drop, weight, density, foam grade, dimensions, gradient) unless the assistant's reply quoted those exact numbers.\n- PREFER pivot questions: different gender ("Do you have these for women?"), different category ("Show me sneakers"), different price/feature filter ("Anything under $100?", "Do you have wider widths?"), or honest comparisons between products already mentioned.\n- Write from the customer's perspective.\n- Keep questions short and specific.\n\nReturn ONLY a JSON array of strings, nothing else.`,
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
              addUsage(result.totalUsage, fuRes.usage || {});
            } catch (fuErr) {
              console.error("[chat] follow-up error:", fuErr?.message);
            }
          }

          controller.enqueue(encoder.encode(sseChunk({ type: "done" })));

          const u = result.totalUsage;
          if (u.cache_creation_input_tokens || u.cache_read_input_tokens) {
            console.log(`[cache] created=${u.cache_creation_input_tokens} read=${u.cache_read_input_tokens} input=${u.input_tokens}`);
          }

          recordChatUsage({
            shop: session.shop,
            model: result.model,
            usage: result.totalUsage,
            toolCalls: result.toolCallCount,
          }).catch((err) => console.error("[chat] usage log error:", err?.message));
        } catch (err) {
          console.error("[chat] stream error:", err?.message || err);
          // classifyAnthropicError tells us if the error was retryable
          // (we already retried up to 2x in withAnthropicRetry — if we
          // got here, retries were exhausted) and gives a stable kind
          // for the customer-facing message.
          const classified = classifyAnthropicError(err);
          if (classified.kind === "rate_limit") {
            incrementRateLimitHits(session.shop).catch(() => {});
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
  } catch (e) {
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
