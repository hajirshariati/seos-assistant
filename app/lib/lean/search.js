// Lean engine — product search.
//
// Applies EXACTLY the structured filters Claude chose — nothing is injected,
// inferred, or silently dropped. If the filters match nothing, the result
// says how many products each filter's removal would bring back
// (`if_relaxed`), so Claude decides how to broaden, honestly. Pure.

import { valueOverlap } from "../similar-attributes.js";
import { matchColorValues } from "../color-match.js";
import { styleName } from "./catalog.js";

const STOP = new Set([
  "a", "an", "the", "and", "or", "for", "with", "of", "to", "in", "on", "my", "me", "i", "you", "your",
  "some", "any", "good", "best", "nice", "pair", "pairs", "shoe", "shoes", "footwear", "product", "products",
  "something", "options", "option", "show", "need", "want", "looking", "like", "that", "this", "is", "are",
]);

const norm = (s) => String(s || "").toLowerCase().replace(/[_/]+/g, " ").replace(/[^a-z0-9$.\s'-]/g, " ").replace(/\s+/g, " ").trim();
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function queryTerms(query) {
  return [...new Set(norm(query).split(" ").filter((w) => w.length >= 3 && !STOP.has(w)))];
}

// Word-prefix match so "sandal" finds "sandals" but "red" never finds "tired".
function hasTerm(text, term) {
  return new RegExp(`(^|[^a-z0-9])${escapeRe(term)}`).test(text);
}

const FIELD_WEIGHTS = [
  ["title", 4],
  ["category", 3],
  ["facets", 2],
  ["tags", 2],
  ["description", 1],
];

// Short field values (labels, yes/no) are facts to filter on; long ones
// (comfort, materials write-ups) are read like the description.
const SHORT_VALUE = 80;
const isShort = (v) => String(v).length <= SHORT_VALUE;

function haystacks(p) {
  const values = Object.values(p.attributes || {});
  return {
    title: norm(p.title),
    category: norm([p.category, p.subcategory, p.productType].join(" ")),
    facets: norm([...p.activities, ...p.conditions, ...p.colors, p.badge, ...values.filter(isShort)].join(" ")),
    tags: norm(p.tags.join(" ")),
    description: norm([p.description, ...values.filter((v) => !isShort(v))].join(" ")),
  };
}

function scoreProduct(p, terms) {
  if (terms.length === 0) return { score: 0, matched: 0 };
  const h = haystacks(p);
  let score = 0;
  let matched = 0;
  for (const t of terms) {
    let hit = false;
    for (const [field, w] of FIELD_WEIGHTS) {
      if (hasTerm(h[field], t)) { score += w; hit = true; }
    }
    if (hit) matched += 1;
  }
  return { score, matched };
}

const lc = (v) => String(v || "").toLowerCase().trim();
const asList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map(lc).filter(Boolean);

function sizeMatches(sizes, want) {
  const w = lc(want).replace(/\s*us$/, "");
  if (!w) return true;
  return sizes.some((s) => {
    const v = s.replace(/\s*us$/, "");
    if (v === w) return true;
    // Range sizes like "7.5 - 8" contain the asked size.
    const parts = v.split(/\s*-\s*/).map(Number).filter(Number.isFinite);
    const n = Number(w);
    return parts.length === 2 && Number.isFinite(n) && n >= parts[0] && n <= parts[1];
  });
}

// Each filter: (product, params, catalogHasGender) → boolean.
const FILTERS = {
  categories: (p, want) => {
    const fields = [p.category, p.subcategory, p.productType].map(lc);
    return want.some((w) => fields.some((f) => f === w || (f && (f.includes(w) || w.includes(f)))));
  },
  colors: (p, want) => matchColorValues(p.colors, want) != null,
  gender: (p, want, catalogHasGender) => {
    if (p.gender.length === 0) return !catalogHasGender;
    return want.some((w) => p.gender.includes(w)) || p.gender.includes("unisex");
  },
  activities: (p, want) => want.some((w) => p.activities.includes(w)),
  conditions: (p, want) => want.some((w) => p.conditions.includes(w) || p.tags.some((t) => lc(t) === w)),
  on_sale: (p, want) => !want[0] || p.onSale,
  max_price: (p, want) => !Number.isFinite(Number(want[0])) || p.price <= Number(want[0]),
  size: (p, want) => sizeMatches(p.sizes, want[0]),
};

function activeFilters(params = {}) {
  const out = {};
  for (const key of Object.keys(FILTERS)) {
    const raw = params[key];
    if (key === "on_sale") { if (raw === true) out[key] = [true]; continue; }
    if (key === "max_price") { if (Number.isFinite(Number(raw)) && Number(raw) > 0) out[key] = [Number(raw)]; continue; }
    const vals = asList(raw);
    if (vals.length) out[key] = vals;
  }
  return out;
}

function passes(p, filters, catalogHasGender, skip = null) {
  for (const [key, want] of Object.entries(filters)) {
    if (key === skip) continue;
    if (!FILTERS[key](p, want, catalogHasGender)) return false;
  }
  return true;
}

// Search results stay small (fast, cheap): only the short fields. Long text
// comes with get_product_details, when Claude needs it for one product.
function shortDetails(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!isShort(v)) continue;
    out[k] = String(v);
    if (Object.keys(out).length >= 8) break;
  }
  return out;
}

export function toModelProduct(p, { otherColors = [] } = {}) {
  return {
    handle: p.handle,
    title: p.title,
    price: p.priceLabel,
    ...(p.onSale ? { on_sale: true, compare_at_price: `$${p.compareAtPrice.toFixed(2)}` } : {}),
    category: p.category,
    gender: p.gender.join(", ") || undefined,
    colors: p.colors,
    ...(otherColors.length ? { same_style_other_colors: otherColors } : {}),
    activities: p.activities.length ? p.activities : undefined,
    helps_with: p.conditions.length ? p.conditions.slice(0, 8) : undefined,
    badge: p.badge || undefined,
    ...(Object.keys(shortDetails(p.attributes || {})).length ? { details: shortDetails(p.attributes) } : {}),
    sizes_in_stock: p.sizes.slice(0, 16),
    widths_in_stock: p.widths.length ? p.widths : undefined,
    summary: p.description.slice(0, 240),
  };
}

export function leanSearch(catalog, params = {}) {
  const products = (catalog?.products || []).filter((p) => p.inStock);
  const catalogHasGender = products.some((p) => p.gender.length > 0);
  const filters = activeFilters(params);
  const terms = queryTerms(params.query);
  const limit = Math.min(Math.max(Number(params.limit) || 6, 1), 10);

  const matches = products.filter((p) => passes(p, filters, catalogHasGender));
  let ranked = matches
    .map((p) => ({ p, ...scoreProduct(p, terms) }))
    .sort((a, b) => b.matched - a.matched || b.score - a.score || a.p.price - b.p.price);
  // The query narrows too: when some filtered products match its words, only
  // those count. If none do, the structured filters alone define the request.
  const queryMatched = terms.length === 0 || ranked.some((x) => x.matched > 0);
  if (terms.length > 0 && queryMatched) ranked = ranked.filter((x) => x.matched > 0);
  else if (terms.length > 0 && Object.keys(filters).length === 0) ranked = [];

  // One card per style; the other in-stock colors of that style ride along.
  const styleColors = new Map();
  for (const p of products) {
    const k = p.style.toLowerCase();
    if (!styleColors.has(k)) styleColors.set(k, new Set());
    for (const c of p.colors) styleColors.get(k).add(c);
  }
  const seenStyles = new Set();
  const picked = [];
  for (const x of ranked) {
    const k = x.p.style.toLowerCase();
    if (seenStyles.has(k)) continue;
    seenStyles.add(k);
    const others = [...(styleColors.get(k) || [])].filter((c) => !x.p.colors.includes(c));
    picked.push(toModelProduct(x.p, { otherColors: others }));
    if (picked.length >= limit) break;
  }

  const result = {
    total_matches: ranked.length,
    filters_applied: Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, k === "on_sale" || k === "max_price" || k === "size" ? v[0] : v])),
    products: picked,
    ...(!queryMatched && picked.length > 0
      ? { note: `No product matched the words "${params.query}"; these match the filters only — check they fit before recommending, or search differently.` }
      : {}),
  };
  if (picked.length === 0 && Object.keys(filters).length > 0) {
    // How many products come back if each filter alone is dropped — Claude
    // chooses the honest broadening (e.g. "no red wedges, but 4 red sandals").
    result.if_relaxed = Object.fromEntries(
      Object.keys(filters).map((key) => [
        `without_${key}`,
        products.filter((p) => passes(p, filters, catalogHasGender, key)).length,
      ]),
    );
  }
  return result;
}

export function productDetails(catalog, handle) {
  const p = (catalog?.products || []).find((x) => x.handle === handle);
  if (!p) return null;
  const siblings = (catalog.products || []).filter((x) => x.style.toLowerCase() === p.style.toLowerCase() && x.inStock);
  return {
    ...toModelProduct(p),
    in_stock: p.inStock,
    description: p.description.slice(0, 1500),
    ...(Object.keys(p.attributes || {}).length ? { details: p.attributes } : {}),
    tags: p.tags.slice(0, 30),
    style_colorways: siblings.map((s) => ({ handle: s.handle, title: s.title, colors: s.colors, price: s.priceLabel })),
  };
}

// "Something like the Savannah": same category and line, plus the qualities
// the store chose (Catalog → "Show me something similar"), excluding the style
// itself. Ranked by how many of those qualities match.
export function similarProducts(catalog, { handle, attributes = [], limit = 6, max_price } = {}) {
  const products = catalog?.products || [];
  const ref = products.find((x) => x.handle === handle);
  if (!ref) return { error: "No product with that handle. Search first." };
  const want = attributes.map((a) => String(a).toLowerCase());
  const valueOf = (p, key) => {
    if (key === "color" || key === "colors" || key === "color_family") return p.colors.join(", ");
    if (key === "activity") return p.activities.join(", ");
    if (key === "helps_with") return p.conditions.join(", ");
    return lc(p.attributes?.[key] || "");
  };
  const scored = [];
  for (const p of products) {
    if (!p.inStock || lc(p.style) === lc(ref.style)) continue;
    if (lc(p.category) !== lc(ref.category)) continue;
    if (ref.gender.length && p.gender.length && !p.gender.some((g) => ref.gender.includes(g) || g === "unisex")) continue;
    if (Number.isFinite(max_price) && p.price > max_price) continue;
    let score = 0;
    for (const key of want) score += valueOverlap(valueOf(ref, key), valueOf(p, key));
    if (want.length && score === 0) continue;
    scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.p.price - b.p.price);
  const seenStyles = new Set();
  const out = [];
  for (const { p } of scored) {
    if (seenStyles.has(lc(p.style))) continue;
    seenStyles.add(lc(p.style));
    out.push(toModelProduct(p));
    if (out.length >= Math.min(Math.max(1, limit || 6), 10)) break;
  }
  return { reference: ref.title, matched_on: ["category", "line", ...want], products: out };
}

export { styleName };
