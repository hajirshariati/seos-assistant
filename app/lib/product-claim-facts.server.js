// Canonical product claim-facts builder.
//
// Single source of truth for the verifier-side facts attached to
// every product card. Every emit path — search_products,
// find_similar_products, get_product_details, lookup_sku,
// recommend_* — funnels its product shape through
// buildProductClaimFacts so the verifier never sees ad-hoc subsets.
//
// Each fact is returned with provenance — { value, source, evidence }
// — so when the verifier drops a sentence, the log can show which
// fact-source was checked and what it returned. Cards carry the
// value on the legacy `_<field>` keys (boolean / array / null) for
// backwards compatibility with the existing claim verifier, plus a
// `_claimFacts` envelope for richer access (used by the missing-
// proof log and path-parity tests).

import { __internals as catalogFactInternals, normalizeCategory } from "./catalog-facts.server.js";

const {
  extractMerchantConditionTags,
  extractMerchantUseCaseTags,
} = catalogFactInternals;

// Brand-rules registry. Keyed by exact shop domain so a rule is
// opt-in per shop. Currently hard-coded — when a multi-brand layer
// ships, lift these into ShopSettings rows.
//
// archSupportFromFootwearCategory: when set, any product whose
// canonical category is in FOOTWEAR_CATEGORIES carries
// _archSupport=true even when the title/description didn't
// literally name "arch support". Aetrex's brand positioning
// guarantees built-in arch support on every footwear product, but
// older catalog rows have sparse descriptions and lose the proof.
const BRAND_RULES = {
  "aetrex.myshopify.com": { archSupportFromFootwearCategory: true },
};

const FOOTWEAR_CATEGORIES = new Set([
  "sneakers",
  "sandals",
  "boots",
  "loafers",
  "oxfords",
  "clogs",
  "slip-ons",
  "slippers",
  "mary-janes",
  "wedges-heels",
]);

const NON_FOOTWEAR_CATEGORIES = new Set(["orthotics", "accessories"]);

function brandRule(shopContext) {
  const shop = String(shopContext?.shop || "").toLowerCase();
  return BRAND_RULES[shop] || {};
}

// Canonical product shape expected by the builder:
//   {
//     title, handle, productType,
//     description, descriptionSnippet,
//     tags: string[],
//     attributes: object,         // merchant attribute bag
//     price, compareAtPrice,
//   }
//
// Use lookupSkuToCanonical / recommenderProductToCanonical to
// adapt the non-standard shapes (productTitle/productAttributes/
// productDescription, etc.) before calling.
export function buildProductClaimFacts(product = {}, shopContext = {}) {
  const facts = {};
  facts.category       = buildCategory(product);
  facts.conditionTags  = buildConditionTags(product);
  facts.useCaseTags    = buildUseCaseTags(product);
  facts.onSale         = buildOnSale(product);
  facts.removableInsole= buildRemovableInsole(product);
  facts.archSupport    = buildArchSupport(product, shopContext, facts.category);
  facts.waterFriendly  = buildWaterFriendly(product);
  facts.footbed        = buildStringAttr(product, "footbed");
  facts.badge          = buildStringAttr(product, "badge");
  facts.productLine    = buildStringAttr(product, "orthotic_line");
  facts._meta = {
    handle: product.handle || null,
    title: product.title || null,
    shop: shopContext?.shop || null,
  };
  return facts;
}

// Project the canonical fact bag onto the legacy `_field` keys
// the verifier reads. Keeps backwards-compat as we migrate paths
// over. Also attaches the full provenance bag as `_claimFacts` so
// the missing-proof log and parity tests can introspect.
export function projectClaimFactsToCardFields(facts = {}) {
  return {
    _conditionTags:   facts.conditionTags?.value ?? [],
    _useCaseTags:     facts.useCaseTags?.value ?? [],
    _onSale:          facts.onSale?.value ?? false,
    _removableInsole: facts.removableInsole?.value ?? null,
    _archSupport:     facts.archSupport?.value ?? false,
    _waterFriendly:   facts.waterFriendly?.value ?? false,
    _footbed:         facts.footbed?.value ?? null,
    _badge:           facts.badge?.value ?? null,
    _productLine:     facts.productLine?.value ?? null,
    _claimFacts:      facts,
  };
}

// One-call convenience for callers that already have the canonical
// product shape.
export function attachClaimFactsToCard(product, shopContext) {
  return projectClaimFactsToCardFields(buildProductClaimFacts(product, shopContext));
}

// ─── shape adapters ──────────────────────────────────────────────

// lookup_sku entries use productTitle / productAttributes /
// productTags / productDescription. Convert to the canonical shape
// so the builder sees the same input as a search_products card.
export function lookupSkuToCanonical(f = {}) {
  return {
    title: f.productTitle,
    handle: f.productHandle,
    productType: f.productType,
    description: f.productDescription,
    descriptionSnippet: "",
    tags: Array.isArray(f.productTags) ? f.productTags : [],
    attributes: f.productAttributes || {},
    price: f.price,
    compareAtPrice: f.compareAtPrice,
  };
}

// Recommender output shape: a `product` object with the same keys
// as a search_products entry, but the chat-tools card emit was
// previously skipping claim facts entirely. Channel it through the
// same builder.
export function recommenderProductToCanonical(p = {}) {
  return {
    title: p.title,
    handle: p.handle,
    productType: p.productType,
    description: p.description || "",
    descriptionSnippet: p.descriptionSnippet || "",
    tags: Array.isArray(p.tags) ? p.tags : [],
    attributes: p.attributes || {},
    price: p.price,
    compareAtPrice: p.compareAtPrice,
  };
}

// ─── per-claim builders ─────────────────────────────────────────

function buildCategory(p) {
  const attrs = p.attributes || {};
  const raw =
    attrs.category ??
    attrs.Category ??
    attrs.category_for_filter ??
    attrs.subcategory ??
    p.productType ??
    null;
  if (!raw) return { value: null, source: "none", evidence: {} };
  const display = Array.isArray(raw)
    ? String(raw[0] || "").toLowerCase().trim()
    : String(raw || "").toLowerCase().trim();
  const normalized = normalizeCategory(display);
  return {
    value: normalized || display || null,
    source: normalized ? "attribute_normalized" : "attribute_raw",
    evidence: { display, raw },
  };
}

function buildConditionTags(p) {
  const tags = Array.isArray(p.tags) ? p.tags : [];
  const attrs = p.attributes || {};
  // extractMerchantConditionTags expects { tags, attributesJson }
  const value = extractMerchantConditionTags({
    tags,
    attributesJson: attrs,
  });
  const evidence = { tags_input: tags, helps_with_input: attrs.helps_with ?? null };
  const source = value.length
    ? (attrs.helps_with != null ? "merchant_tags+helps_with" : "merchant_tags")
    : "none";
  return { value, source, evidence };
}

function buildUseCaseTags(p) {
  const attrs = p.attributes || {};
  const value = extractMerchantUseCaseTags({ attributesJson: attrs });
  const evidence = {
    activity_input:
      attrs.activity ??
      attrs.attr_activity_shoe_type_for_filter ??
      attrs.attr_activity_shoe_type ??
      null,
  };
  return {
    value,
    source: value.length ? "activity_attribute" : "none",
    evidence,
  };
}

function buildOnSale(p) {
  const price = parseFloat(p.price);
  const compareAt = parseFloat(p.compareAtPrice);
  const v = Number.isFinite(price) && Number.isFinite(compareAt) && compareAt > price;
  return {
    value: v,
    source: v ? "price_compare" : "none",
    evidence: { price, compareAt },
  };
}

function buildRemovableInsole(p) {
  const text = String(p.descriptionSnippet || p.description || "");
  if (!text) return { value: null, source: "none", evidence: {} };
  if (/removable\s+insole\s*[:\-]\s*(?:yes|removable)\b/i.test(text)) {
    return { value: true, source: "description_match", evidence: { phrase: "yes/removable" } };
  }
  if (/removable\s+insole\s*[:\-]\s*(?:no|none)\b/i.test(text)) {
    return { value: false, source: "description_match", evidence: { phrase: "no/none" } };
  }
  return { value: null, source: "none", evidence: {} };
}

// Three-tier arch-support proof: explicit title/description scan,
// merchant footbed attribute, brand-rule category fallback. The
// last tier exists because Aetrex's "Built-In Arch Support" copy
// got stripped from some product descriptions during a Shopify
// import — the claim is true by brand positioning but the card-
// level evidence vanished. Brand rule fires only when scoped to a
// shop that opted in (BRAND_RULES).
function buildArchSupport(p, shopContext, categoryFact) {
  const text = String(p.title || "") + " " + String(p.descriptionSnippet || p.description || "");
  if (/\barch\s+support\b/i.test(text)) {
    return {
      value: true,
      source: "title_description_scan",
      evidence: { match: "arch support" },
    };
  }
  const attrs = p.attributes || {};
  const footbed = String(attrs.footbed || "").toLowerCase();
  if (footbed.includes("arch") || footbed.includes("orthotic")) {
    return { value: true, source: "footbed_attribute", evidence: { footbed } };
  }
  const rules = brandRule(shopContext);
  if (rules.archSupportFromFootwearCategory) {
    const category = categoryFact?.value || null;
    if (category && FOOTWEAR_CATEGORIES.has(category)) {
      return {
        value: true,
        source: "brand_rule_footwear_category",
        evidence: { category, shop: shopContext?.shop || null },
      };
    }
    if (category && NON_FOOTWEAR_CATEGORIES.has(category)) {
      return {
        value: false,
        source: "brand_rule_non_footwear_category",
        evidence: { category },
      };
    }
  }
  return { value: false, source: "none", evidence: {} };
}

function buildWaterFriendly(p) {
  const text = String(p.title || "") + " " + String(p.descriptionSnippet || p.description || "");
  if (/\bwater[\s-]?friendly\b/i.test(text)) {
    return {
      value: true,
      source: "title_description_scan",
      evidence: { match: "water-friendly" },
    };
  }
  return { value: false, source: "none", evidence: {} };
}

function buildStringAttr(p, key) {
  const v = (p.attributes || {})[key];
  if (v == null) return { value: null, source: "none", evidence: {} };
  let s;
  if (Array.isArray(v)) {
    const first = v.find((x) => x != null && x !== "");
    s = first ? String(first).toLowerCase().trim() : null;
  } else {
    s = String(v).toLowerCase().trim() || null;
  }
  if (!s) return { value: null, source: "none", evidence: {} };
  return { value: s, source: `attribute:${key}`, evidence: { key, raw: v } };
}

// ─── verifier-side helpers ──────────────────────────────────────

// Map a verifier claim kind onto a human-readable proof-source
// label. Used by the missing-proof log so a dropped sentence
// names the fact path that returned negative.
export function claimSourcesChecked(claimKind, card) {
  const facts = card?._claimFacts || null;
  if (!facts) {
    // Pre-canonical-builder card. Surface the legacy fields only.
    return ["legacy_card_fields"];
  }
  switch (claimKind) {
    case "condition":
      return ["merchant_tags", "helps_with_attribute"];
    case "useCase":
      return ["activity_attribute"];
    case "archSupport":
      return [
        "title_description_scan",
        "footbed_attribute",
        "brand_rule_footwear_category",
      ];
    case "waterFriendly":
      return ["title_description_scan"];
    case "removableInsole":
      return ["description_match"];
    case "onSale":
      return ["price_compare"];
    case "footbedSubstring":
      return ["attribute:footbed"];
    case "badgeSubstring":
      return ["attribute:badge"];
    default:
      return [];
  }
}

// Exported for the audit script + tests.
export const __internals = {
  BRAND_RULES,
  FOOTWEAR_CATEGORIES,
  NON_FOOTWEAR_CATEGORIES,
  brandRule,
};
