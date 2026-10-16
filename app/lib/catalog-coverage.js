// Catalog data coverage — how much of the catalog the assistant can actually
// filter on, per field, and where each value comes from.
//
// The 2026-10-16 "red shoes" failure was invisible until a customer hit it:
// color/gender lived in metafields the app wasn't reading, so every color and
// gender filter silently failed. This report makes that gap visible in the
// admin BEFORE a shopper finds it. Pure — the caller passes products (with
// variants), the merchant's mappings, and a condition-tag extractor.

import { titleSuffixColor } from "./color-match.js";

const FIELDS = [
  { key: "color", label: "Color", attrs: ["color", "colour", "color_family", "colour_family"], core: true,
    use: "“red shoes”, “in black?”" },
  { key: "gender", label: "Gender", attrs: ["gender", "genders", "gender_fallback"], core: true,
    use: "“women's sandals”, “for my husband”" },
  { key: "category", label: "Category", attrs: ["category", "category_for_filter", "subcategory"], core: true,
    use: "“boots”, “sneakers” vs. orthotics" },
  { key: "conditions", label: "Conditions", attrs: ["helps_with", "condition", "recommended_for"], core: true,
    use: "“good for plantar fasciitis”, “bunions”" },
  { key: "activity", label: "Activity / use", attrs: ["activity", "use_case"], core: false,
    use: "“for walking”, “for the office”" },
  { key: "badge", label: "Badge", attrs: ["badge"], core: false, optional: true,
    use: "“new arrivals”, “limited release”" },
];

function attrsOf(p) {
  const a = p?.attributesJson;
  if (!a) return {};
  if (typeof a === "string") {
    try { return JSON.parse(a) || {}; } catch { return {}; }
  }
  return a;
}

function hasValue(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.some(hasValue);
  return String(v).trim() !== "";
}

function readCI(bag, keys) {
  if (!bag || typeof bag !== "object") return null;
  const want = new Set(keys.map((k) => String(k).toLowerCase()));
  for (const [k, v] of Object.entries(bag)) {
    if (want.has(String(k).toLowerCase()) && hasValue(v)) return v;
  }
  return null;
}

function optionBag(raw) {
  let v = raw;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return {}; } }
  if (Array.isArray(v)) return Object.fromEntries(v.filter((o) => o?.name != null).map((o) => [o.name, o.value]));
  return v && typeof v === "object" ? v : {};
}

const GENDER_TITLE_RE = /\b(?:wo)?men'?s\b|\bunisex\b|\b(?:boy|girl|kid|children)'?s\b/i;

// Returns the source a product's value comes from for one field, or null.
function sourceFor(field, p, mappedAttrs, conditionTagsOf) {
  const attrs = attrsOf(p);
  const attrHit = field.attrs.find((k) => readCI(attrs, [k]) != null);
  if (attrHit) return mappedAttrs.has(attrHit) ? "mapped" : "auto";
  const variantAttrHit = (p.variants || []).some((v) => readCI(attrsOf(v), field.attrs) != null);
  if (variantAttrHit) return "mapped";
  switch (field.key) {
    case "color":
      if ((p.variants || []).some((v) => readCI(optionBag(v.optionsJson), ["color", "colour"]) != null)) return "variant";
      if (titleSuffixColor(p.title)) return "title";
      return null;
    case "gender":
      return GENDER_TITLE_RE.test(String(p.title || "")) ? "title" : null;
    case "category":
      return hasValue(p.productType) ? "productType" : null;
    case "conditions":
      return typeof conditionTagsOf === "function" && conditionTagsOf(p).length > 0 ? "tags" : null;
    default:
      return null;
  }
}

export const COVERAGE_SOURCE_LABELS = {
  mapped: "your mapping",
  auto: "auto-detected metafield",
  variant: "variant option",
  title: "product title",
  productType: "product type",
  tags: "product tags",
};

export function computeCatalogCoverage({ products = [], mappings = [], conditionTagsOf = null } = {}) {
  const active = (products || []).filter(
    (p) => !/^(draft|archived)$/i.test(String(p?.status || "")),
  );
  const mappedAttrs = new Set((mappings || []).map((m) => String(m?.attribute || "").toLowerCase()));
  const total = active.length;
  const rows = FIELDS.map((field) => {
    const sources = {};
    let covered = 0;
    for (const p of active) {
      const src = sourceFor(field, p, mappedAttrs, conditionTagsOf);
      if (!src) continue;
      covered++;
      sources[src] = (sources[src] || 0) + 1;
    }
    const pct = total > 0 ? Math.round((covered / total) * 100) : 0;
    // Title / productType fallbacks work, but they're weaker than real data:
    // a title can't say "women" for an ungendered sneaker name.
    const strong = (sources.mapped || 0) + (sources.auto || 0) + (sources.variant || 0);
    const strongPct = total > 0 ? Math.round((strong / total) * 100) : 0;
    let status = "good";
    if (field.optional) status = covered > 0 ? "good" : "info";
    else if (pct < 50) status = "missing";
    else if (pct < 90 || (field.core && strongPct < 50)) status = "partial";
    return { key: field.key, label: field.label, use: field.use, core: field.core, covered, total, pct, strongPct, sources, status };
  });
  const gaps = rows.filter((r) => r.core && r.status !== "good").map((r) => r.label);
  return { total, rows, gaps };
}
