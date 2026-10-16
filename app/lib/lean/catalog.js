// Lean engine — catalog view.
//
// The lean engine's contract: Claude decides what the customer means; code
// supplies FACTS and checks facts. This module turns synced Product rows into
// plain product facts (category, colors, gender, activities, conditions, price,
// stock, sizes) and builds the store's real vocabulary from them, so the search
// tool can offer Claude the catalog's own words. Nothing here interprets the
// customer. Pure — the DB loader lives in catalog.server.js.

import { titleSuffixColor } from "../color-match.js";

function parseJson(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return null; }
}

function list(v) {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return v.flatMap(list);
  const s = String(v).trim();
  if (s.startsWith("[")) {
    const arr = parseJson(s);
    if (Array.isArray(arr)) return arr.flatMap(list);
  }
  return s ? [s] : [];
}

function readCI(bag, keys) {
  if (!bag || typeof bag !== "object") return [];
  const want = new Set(keys.map((k) => k.toLowerCase()));
  const out = [];
  for (const [k, v] of Object.entries(bag)) {
    if (want.has(String(k).toLowerCase())) out.push(...list(v));
  }
  return out;
}

function optionBag(raw) {
  const v = parseJson(raw);
  if (Array.isArray(v)) return Object.fromEntries(v.filter((o) => o?.name != null).map((o) => [o.name, o.value]));
  return v && typeof v === "object" ? v : {};
}

function uniqLower(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const s = String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!s || s.startsWith("gid://") || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function money(n) {
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "";
}

// "Savannah Adjustable Quarter Strap Sandal - Red" → "Savannah Adjustable Quarter Strap Sandal"
export function styleName(title) {
  return String(title || "").replace(/\s+[-–—]\s+[^-–—]+$/, "").replace(/\s+/g, " ").trim();
}

export function productUrl(shop, handle) {
  return `https://${shop}/products/${handle}?utm_content=SEoS`;
}

// Attribute keys already turned into first-class facts above.
const CORE_ATTRIBUTE_KEYS = new Set([
  "category_for_filter", "category", "subcategory", "gender", "genders", "gender_fallback",
  "color", "colour", "color_family", "colour_family", "activity", "use_case",
  "helps_with", "recommended_for", "condition", "badge",
]);

// Every other product field the store chose to share (footbed, materials,
// heel height…) — as short readable text, so Claude can answer and filter.
// A value that repeats one already known (the same data in two metafields,
// or a copy of the category / colors) is kept once.
function extraAttributes(attrs, known = []) {
  const out = {};
  const seen = new Set(known.map((v) => String(v).toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean));
  for (const [k, v] of Object.entries(attrs || {})) {
    const key = String(k).toLowerCase();
    if (CORE_ATTRIBUTE_KEYS.has(key)) continue;
    const vals = list(v).map((x) => String(x).trim()).filter((x) => x && !x.startsWith("gid://"));
    if (!vals.length) continue;
    const text = vals.join(", ").replace(/\s+/g, " ").slice(0, 800);
    const norm = text.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out[key] = text;
  }
  return out;
}

export function normalizeProduct(row, { shop = "" } = {}) {
  const attrs = parseJson(row.attributesJson) || {};
  const variants = Array.isArray(row.variants) ? row.variants : [];
  const inStockVariants = variants.filter((v) => v?.inventoryQty == null || Number(v.inventoryQty) > 0);
  const priced = (inStockVariants.length ? inStockVariants : variants)
    .map((v) => ({ price: parseFloat(v?.price), compareAt: parseFloat(v?.compareAtPrice) }))
    .filter((v) => Number.isFinite(v.price));
  const minPrice = priced.length ? Math.min(...priced.map((v) => v.price)) : NaN;
  const maxPrice = priced.length ? Math.max(...priced.map((v) => v.price)) : NaN;
  const compareAt = priced
    .filter((v) => Number.isFinite(v.compareAt) && v.compareAt > v.price)
    .map((v) => v.compareAt);
  const compareAtPrice = compareAt.length ? Math.max(...compareAt) : NaN;

  const sizes = uniqLower(inStockVariants.flatMap((v) => readCI(optionBag(v.optionsJson), ["size"])));
  const widths = uniqLower(inStockVariants.flatMap((v) => readCI(optionBag(v.optionsJson), ["width"])));
  const colors = uniqLower([
    ...readCI(attrs, ["color", "colour", "color_family", "colour_family"]),
    ...variants.flatMap((v) => readCI(optionBag(v.optionsJson), ["color", "colour"])),
    titleSuffixColor(row.title) || "",
  ]);

  const category = String(readCI(attrs, ["category_for_filter", "category"])[0] || row.productType || "").trim();
  const gender = uniqLower(readCI(attrs, ["gender", "genders", "gender_fallback"]));
  const activities = uniqLower(readCI(attrs, ["activity", "use_case"]));
  const conditions = uniqLower(readCI(attrs, ["helps_with", "recommended_for", "condition"]));
  return {
    handle: row.handle,
    title: row.title,
    style: styleName(row.title),
    url: productUrl(shop, row.handle),
    image: row.featuredImageUrl || "",
    productType: String(row.productType || "").trim(),
    category,
    subcategory: String(readCI(attrs, ["subcategory"])[0] || "").trim(),
    gender,
    colors,
    activities,
    conditions,
    badge: String(readCI(attrs, ["badge"])[0] || "").trim(),
    attributes: extraAttributes(attrs, [
      category, row.productType, row.title,
      gender.join(", "), colors.join(", "), activities.join(", "), conditions.join(", "),
      ...gender, ...colors, ...activities, ...conditions,
    ]),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    description: String(row.description || "").replace(/\s+/g, " ").trim(),
    price: minPrice,
    maxPrice,
    priceLabel: !Number.isFinite(minPrice) ? "" : minPrice === maxPrice ? money(minPrice) : `${money(minPrice)}–${money(maxPrice)}`,
    compareAtPrice,
    onSale: Number.isFinite(compareAtPrice) && compareAtPrice > minPrice,
    inStock: variants.length === 0 || inStockVariants.length > 0,
    sizes,
    widths,
  };
}

// Count values across products → [{ value, count }] sorted by count.
function tally(products, pick, { max = 60, min = 1 } = {}) {
  const counts = new Map();
  for (const p of products) {
    for (const v of pick(p)) {
      const key = String(v || "").trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= min)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([value, count]) => ({ value, count }));
}

export function buildVocabulary(products = []) {
  const live = products.filter((p) => p.inStock);
  return {
    productTypes: tally(live, (p) => [p.productType], { max: 20 }),
    categories: tally(live, (p) => [p.category, p.subcategory].filter(Boolean).map((s) => s.toLowerCase()), { max: 40 }),
    colors: tally(live, (p) => p.colors, { max: 80, min: 2 }),
    genders: tally(live, (p) => p.gender, { max: 6 }),
    activities: tally(live, (p) => p.activities, { max: 30, min: 2 }),
    conditions: tally(live, (p) => p.conditions, { max: 40, min: 2 }),
    total: live.length,
  };
}

export function buildLeanCatalog(rows = [], { shop = "" } = {}) {
  const products = rows
    .filter((r) => r && r.handle && !/^(draft|archived)$/i.test(String(r.status || "")))
    .map((r) => normalizeProduct(r, { shop }));
  // One product per colorway ("Ashley Wedge - Navy", "Ashley Wedge - Champagne"):
  // when several products share a style and differ only by the " - X" suffix,
  // that suffix IS the colorway — even names no color list knows (Chai, Oatmeal).
  const byStyle = new Map();
  for (const p of products) {
    const k = p.style.toLowerCase();
    if (!byStyle.has(k)) byStyle.set(k, []);
    byStyle.get(k).push(p);
  }
  for (const group of byStyle.values()) {
    if (group.length < 2) continue;
    for (const p of group) {
      const m = String(p.title).match(/\s[-–—]\s*([^–—-]{2,40})$/);
      const suffix = m ? m[1].trim().toLowerCase().replace(/\s+/g, " ") : "";
      if (suffix && !p.colors.includes(suffix)) p.colors.push(suffix);
    }
  }
  return { products, vocab: buildVocabulary(products) };
}
