// Lean engine — catalog view.
//
// The lean engine's contract: Claude decides what the customer means; code
// supplies FACTS and checks facts. This module turns synced Product rows into
// plain product facts (category, colors, gender, activities, conditions, price,
// stock, sizes) and builds the store's real vocabulary from them, so the search
// tool can offer Claude the catalog's own words. Nothing here interprets the
// customer. Pure — the DB loader lives in catalog.server.js.

import { titleSuffixColor } from "../color-match.js";
import { applySpecs, SPEC_FILTERS } from "../product-specs.js";

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

// What a product is, for the fit helpers: True Fit sizes shoes, FITFinder
// picks orthotics — neither may be offered for the other.
const ORTHOTIC_WORDS = /orthotic|insole|insert|footbed/i;
const FOOTWEAR_WORDS = /footwear|shoe|sneaker|sandal|boot|loafer|clog|mule|flat|wedge|heel|slipper|oxford|slide|flip|trainer|runner/i;
export function productKind(p = {}) {
  const text = `${p.productType || ""} ${p.category || ""} ${p.subcategory || ""}`;
  if (ORTHOTIC_WORDS.test(text)) return "orthotic";
  if (FOOTWEAR_WORDS.test(text)) return "footwear";
  return "other";
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
    // Some stores keep HTML in text fields (<ul><li>…) — keep only the words.
    const text = vals.join(", ")
      .replace(/<\/(li|p|div)>\s*/gi, "; ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s*;\s*(?=;|$)/g, "")
      .replace(/([.!?])\s*;/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 800);
    if (!text) continue;
    const norm = text.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out[key] = text;
  }
  return out;
}

// The store's own product codes for a product, lowercased: each variant SKU
// ("L820W07"), its style stems ("l820w", "l820"), and the code in the handle
// ("l820w-m", "janey-sport-navy-l9505w"). Shoppers type these ("L820") and
// they're never in a title, so search matches them exactly.
const CODE = /^[a-z]{1,4}\d{2,}[a-z0-9]*$/;
export function productCodes(handle, skus = []) {
  const out = new Set();
  const addStems = (code) => {
    if (!CODE.test(code)) return;
    out.add(code);
    const m = code.match(/^([a-z]{1,4}\d{2,})([a-z]*)/);
    if (m) { out.add(m[1]); if (m[2]) out.add(m[1] + m[2]); }
  };
  for (const sku of skus) addStems(String(sku || "").toLowerCase().replace(/[^a-z0-9]/g, ""));
  for (const part of String(handle || "").toLowerCase().split(/[^a-z0-9]+/)) addStems(part);
  return [...out];
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

  // Every option the product is sold in (Size, Width, …) with its values in
  // store order — exact strings, so a chosen value maps to a real variant.
  const options = {};
  for (const v of variants) {
    for (const [name, value] of Object.entries(optionBag(v.optionsJson))) {
      const val = String(value ?? "").trim();
      if (!name || !val) continue;
      if (!options[name]) options[name] = [];
      if (!options[name].includes(val)) options[name].push(val);
    }
  }

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
    codes: productCodes(row.handle, variants.map((v) => v?.sku)),
    title: row.title,
    style: styleName(row.title),
    url: productUrl(shop, row.handle),
    image: row.featuredImageUrl || "",
    productType: String(row.productType || "").trim(),
    options,
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
    // The option values of each variant in stock ({ Size: "7 US", Width: "M" }),
    // so a size picked for the customer can be checked before it's offered.
    stock: inStockVariants.map((v) => optionBag(v.optionsJson)).filter((o) => Object.keys(o).length),
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
    widths: tally(live, (p) => p.widths, { max: 8 }),
    genders: tally(live, (p) => p.gender, { max: 6 }),
    activities: tally(live, (p) => p.activities, { max: 30, min: 2 }),
    conditions: tally(live, (p) => p.conditions, { max: 40, min: 2 }),
    // In-stock products each spec filter would find (removable footbed, no
    // pig products…) — a filter is offered only when it finds some.
    specs: Object.fromEntries(Object.entries(SPEC_FILTERS).map(([k, test]) => [k, live.filter((p) => test(p.specFlags || {})).length])),
    total: live.length,
  };
}

// specRows: the store's product spec sheet (product-specs.js), cleaned rows.
export function buildLeanCatalog(rows = [], { shop = "", specRows = [] } = {}) {
  const products = rows
    .filter((r) => r && r.handle && !/^(draft|archived)$/i.test(String(r.status || "")))
    .map((r) => normalizeProduct(r, { shop }));
  // Spec facts: the sheet's, where the product page doesn't already say,
  // plus the yes/no facts the page itself states ("Removable Insole: Yes").
  const { byHandle: specsOf, report: specReport } = applySpecs(products, specRows);
  for (const p of products) {
    const s = specsOf.get(p.handle);
    p.specs = s?.specs || {};
    p.specFlags = s?.flags || {};
  }
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
  // Product code → the products carrying it (a style code covers every colorway).
  const byCode = new Map();
  for (const p of products) {
    for (const c of p.codes) {
      if (!byCode.has(c)) byCode.set(c, []);
      byCode.get(c).push(p);
    }
  }
  return { products, vocab: buildVocabulary(products), byCode, specReport: specRows.length ? specReport : null };
}

// One typo apart: a letter added or left out ("l2400" / "ll2400"), two
// neighbors swapped, or one character changed.
export function oneEditApart(a, b) {
  if (a === b) return false;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let i = 0;
    while (a[i] === b[i]) i++;
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}

// Worth a close look: letters and at least three digits ("l2400"), not a
// size ("size10") or an order number (digits only).
const looksLikeCode = (w) => w.length >= 4 && /[a-z]/.test(w) && (w.match(/\d/g) || []).length >= 3;

// The store's codes one typo away from a typed one, closest kind first (a
// letter added or left out — the box says "L2400", the product is
// "LL2400"), at most three codes.
export function closeCodes(byCode, word) {
  if (!byCode?.size || !looksLikeCode(word)) return [];
  const found = [];
  for (const [code, products] of byCode) {
    if (!products.length || !looksLikeCode(code) || !oneEditApart(word, code)) continue;
    found.push({ code, products, rank: code.length !== word.length ? 0 : 1 });
  }
  return found.sort((a, b) => a.rank - b.rank || a.code.length - b.code.length).slice(0, 3).map(({ code, products }) => ({ code, products }));
}

// Product codes the customer typed ("L820", "#l2305w", "L 2400") that are
// this store's → [{ code, products, typed, close }]. Order numbers are
// digits, so they never match. With close: true (the default), a code that
// isn't the store's gets the store's codes one typo away, marked close.
export function codesInText(catalog, text, { close = true } = {}) {
  const byCode = catalog?.byCode;
  if (!byCode || !byCode.size) return [];
  const words = String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // "L 2400", "L-2400": a short letter prefix split from its number.
  const joined = words.flatMap((w, i) => (/^[a-z]{1,3}$/.test(w) && /^\d{3,}[a-z0-9]*$/.test(words[i + 1] || "") ? [w + words[i + 1]] : []));
  const seen = new Set();
  const out = [];
  for (const w of [...words, ...joined]) {
    if (!w || seen.has(w) || !/[a-z]/.test(w) || !/\d/.test(w)) continue;
    seen.add(w);
    const products = byCode.get(w);
    if (products?.length) { out.push({ code: w, products, typed: w, close: false }); continue; }
    if (!close) continue;
    for (const c of closeCodes(byCode, w)) {
      if (!out.some((o) => o.code === c.code)) out.push({ ...c, typed: w, close: true });
    }
  }
  return out;
}
