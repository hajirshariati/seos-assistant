// Lean engine — product search.
//
// Applies EXACTLY the structured filters Claude chose — nothing is injected,
// inferred, or silently dropped. If the filters match nothing, the result
// says how many products each filter's removal would bring back
// (`if_relaxed`), so Claude decides how to broaden, honestly. Pure.

import { valueOverlap } from "../similar-attributes.js";
import { matchColorValues, colorFamiliesIn, isColorful } from "../color-match.js";
import { styleName, closeCodes, productKind } from "./catalog.js";
import { merchScore, fewSizesLeft, ratingOf } from "./merch.js";
import { SPEC_FILTERS, SEARCH_SPEC_KEYS } from "../product-specs.js";

// How much merchandising can move a product among equally relevant ones. A
// product whose title matches the request (+4 per word) still beats a better
// seller that only mentions it in its description (+1).
const MERCH_WEIGHT = 2.5;

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

// A yes/no field says what it is in its name ("slip_resistant": "Yes"), so a
// "Yes" makes the name searchable: "slip resistant clogs" finds it. Not a
// "contains_…" field — searching "pig" means avoiding it, not wanting it.
const YES = /^(yes|y|true)$/i;
function yesFieldNames(...bags) {
  const out = [];
  for (const bag of bags) {
    for (const [k, v] of Object.entries(bag || {})) {
      if (YES.test(String(v).trim()) && !/^contains/i.test(k)) out.push(k);
    }
  }
  return out;
}

function haystacks(p) {
  const values = Object.values(p.attributes || {});
  return {
    title: norm(p.title),
    category: norm([p.category, p.subcategory, p.productType].join(" ")),
    facets: norm([...p.activities, ...p.conditions, ...p.colors, p.badge, ...values.filter(isShort), ...yesFieldNames(p.attributes, p.specFlags)].join(" ")),
    tags: norm(p.tags.join(" ")),
    description: norm([p.description, ...values.filter((v) => !isShort(v))].join(" ")),
  };
}

// close: term → Set of products whose code is one typo from it (closeCodes).
function scoreProduct(p, terms, close = null) {
  if (terms.length === 0) return { score: 0, matched: 0 };
  const h = haystacks(p);
  let score = 0;
  let matched = 0;
  for (const t of terms) {
    let hit = false;
    // The store's own product code ("l820"): an exact match outranks any word,
    // and a code one typo off ("l2400" for "ll2400") comes next.
    if (p.codes?.includes(t)) { score += 10; hit = true; }
    else if (close?.get(t)?.has(p)) { score += 8; hit = true; }
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

// A variant in stock with both the size and the width asked for.
const optionOf = (bag, name) => Object.entries(bag || {}).find(([k]) => k.toLowerCase() === name)?.[1];
function sizeAndWidthInStock(p, size, width) {
  return (p.stock || []).some((o) => lc(optionOf(o, "width")) === width && sizeMatches([lc(optionOf(o, "size"))], size));
}

// Each filter: (product, wanted values, { catalogHasGender, collections,
// filters }) → boolean. With both a size and a width, one variant must have
// both. A collection is the seasonal button's (collections.server.js): its
// footwear, unless it has none.
const FILTERS = {
  categories: (p, want) => {
    const fields = [p.category, p.subcategory, p.productType].map(lc);
    return want.some((w) => fields.some((f) => f === w || (f && (f.includes(w) || w.includes(f)))));
  },
  colors: (p, want) => matchColorValues(p.colors, want) != null,
  gender: (p, want, { catalogHasGender }) => {
    if (p.gender.length === 0) return !catalogHasGender;
    return want.some((w) => p.gender.includes(w)) || p.gender.includes("unisex");
  },
  activities: (p, want) => want.some((w) => p.activities.includes(w)),
  conditions: (p, want) => want.some((w) => p.conditions.includes(w) || p.tags.some((t) => lc(t) === w)),
  on_sale: (p, want) => !want[0] || p.onSale,
  max_price: (p, want) => !Number.isFinite(Number(want[0])) || p.price <= Number(want[0]),
  size: (p, want, { filters }) => (filters.width ? sizeAndWidthInStock(p, want[0], filters.width[0]) : sizeMatches(p.sizes, want[0])),
  width: (p, want, { filters }) => (filters.size ? sizeAndWidthInStock(p, filters.size[0], want[0]) : p.widths.includes(want[0])),
  collection: (p, want, { collections }) => {
    const c = collections?.get(want[0]);
    return Boolean(c && c.order.has(p.handle) && (!c.footwearOnly || productKind(p) === "footwear"));
  },
  // Spec filters (removable footbed, no pig products…): only products whose
  // page or spec sheet says so — not knowing never counts as a yes.
  ...Object.fromEntries(Object.entries(SPEC_FILTERS).map(([k, test]) => [k, (p, want) => !want[0] || test(p.specFlags || {})])),
};
const ON_OFF = new Set(["on_sale", ...Object.keys(SPEC_FILTERS)]);

function activeFilters(params = {}) {
  const out = {};
  for (const key of Object.keys(FILTERS)) {
    const raw = params[key];
    if (ON_OFF.has(key)) { if (raw === true) out[key] = [true]; continue; }
    if (key === "max_price") { if (Number.isFinite(Number(raw)) && Number(raw) > 0) out[key] = [Number(raw)]; continue; }
    const vals = asList(raw);
    if (vals.length) out[key] = vals;
  }
  return out;
}

// ctx: { catalogHasGender, collections }.
function passes(p, filters, ctx, skip = null) {
  const kept = skip ? Object.fromEntries(Object.entries(filters).filter(([k]) => k !== skip)) : filters;
  for (const [key, want] of Object.entries(kept)) {
    if (!FILTERS[key](p, want, { ...ctx, filters: kept })) return false;
  }
  return true;
}
const filterContext = (catalog, products) => ({
  catalogHasGender: products.some((p) => p.gender.length > 0),
  collections: catalog?.collections || null,
});

// The collection's own name, the season's words and the button's usual
// words ("fall collection footwear", "new autumn styles") describe the
// collection, not what's in it: with the collection filter on they aren't
// searched for, so they can't narrow it.
const SEASON_WORDS = new Set(["fall", "autumn", "winter", "spring", "summer", "holiday", "season", "seasonal", "collection", "collections",
  "new", "arrivals", "featured", "trending", "styles", "style", "looks", "shoes", "footwear"]);

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

// Spec facts (product-specs.js): the sheet's, plus the yes/no ones the page
// states (removable footbed, a met pad, slip resistant). keys: which ones
// (search results carry the few a shopper decides on; full details all).
function specsOf(p, keys = null) {
  const all = { ...(p.specFlags || {}), ...(p.specs || {}) };
  const out = {};
  for (const [k, v] of Object.entries(all)) if (v && (!keys || keys.includes(k))) out[k] = v;
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
    ...(() => { const r = ratingOf(p); return Number.isFinite(r.rating) ? { rating: r.rating, reviews: Number.isFinite(r.count) ? r.count : undefined } : {}; })(),
    ...(fewSizesLeft(p) ? { few_sizes_left: true } : {}),
    ...(Object.keys(shortDetails(p.attributes || {})).length ? { details: shortDetails(p.attributes) } : {}),
    ...(Object.keys(specsOf(p, SEARCH_SPEC_KEYS)).length ? { specs: specsOf(p, SEARCH_SPEC_KEYS) } : {}),
    sizes_in_stock: p.sizes.slice(0, 16),
    widths_in_stock: p.widths.length ? p.widths : undefined,
    summary: p.description.slice(0, 240),
  };
}

// Every in-stock product a search matches, best first — the one ranking both
// the search tool and the "View all" list use.
function rankMatches(catalog, params = {}) {
  const products = (catalog?.products || []).filter((p) => p.inStock);
  const ctx = filterContext(catalog, products);
  const filters = activeFilters(params);
  const coll = filters.collection ? ctx.collections?.get(filters.collection[0]) || null : null;
  const collWords = new Set(coll ? queryTerms(coll.title) : []);
  const terms = queryTerms(params.query).filter((t) => !coll || (!SEASON_WORDS.has(t) && !collWords.has(t)));

  const matches = products.filter((p) => passes(p, filters, ctx));
  // A typed code that isn't the store's but is one typo from some ("l2400" →
  // "ll2400"): those products count as a match.
  const close = new Map();
  for (const t of terms) {
    if (catalog?.byCode?.has(t)) continue;
    const near = closeCodes(catalog?.byCode, t);
    if (near.length) close.set(t, new Set(near.flatMap((c) => c.products)));
  }
  // Best first: what was asked for, then what sells (sizes in stock, rating,
  // best sellers) — not the cheapest, which is often a last odd size. Price
  // order only when the customer asks for it.
  const sizeFiltered = Boolean(filters.size);
  const sort = String(params.sort || "best");
  const byPrice = (dir) => (a, b) => b.matched - a.matched || dir * (a.p.price - b.p.price) || b.merch - a.merch;
  // colorful: reds, greens, blues, pinks… before black, white and neutrals
  // (a colorway down to its last sizes doesn't jump ahead). In the seasonal
  // collection, the collection's own order comes next — the store's pick.
  const colorful = params.colorful === true;
  const place = (x) => coll.order.get(x.p.handle) ?? Number.MAX_SAFE_INTEGER;
  const best = (a, b) => b.matched - a.matched || b.bright - a.bright ||
    (coll ? b.score - a.score || place(a) - place(b) : 0) ||
    (b.score + MERCH_WEIGHT * b.merch) - (a.score + MERCH_WEIGHT * a.merch) || a.p.price - b.p.price;
  let ranked = matches
    .map((p) => ({
      p, ...scoreProduct(p, terms, close), merch: merchScore(p, { sizeFiltered }),
      bright: colorful && isColorful(p.colors) && !fewSizesLeft(p) ? 1 : 0,
    }))
    .sort(sort === "price_low" ? byPrice(1) : sort === "price_high" ? byPrice(-1) : best);
  // The query narrows too: when some filtered products match its words, only
  // those count. If none do, the structured filters alone define the request.
  const queryMatched = terms.length === 0 || ranked.some((x) => x.matched > 0);
  if (terms.length > 0 && queryMatched) ranked = ranked.filter((x) => x.matched > 0);
  else if (terms.length > 0 && Object.keys(filters).length === 0) ranked = [];
  return { products, ctx, filters, terms, ranked, queryMatched };
}

// All the products a search matched (each colorway is its own product, as on
// the store's own listings), best first.
export function allMatches(catalog, params = {}) {
  return rankMatches(catalog, params).ranked.map((x) => x.p);
}

// The colorway's own name ("Carly Arch Support Sneaker - Navy Sparkle" →
// "Navy Sparkle"), or its first color when the title doesn't carry one.
export function colorwayName(p) {
  const rest = String(p.title || "").slice(String(p.style || "").length).replace(/^\s*[-–—]\s*/, "").trim();
  return rest || p.colors[0] || "";
}

// What a card looks like color-wise, so two cards can be told apart.
const colorKeys = (p) => new Set((p.colors.length ? p.colors : [colorwayName(p)]).flatMap(colorFamiliesIn));
const sharesColor = (keys, used) => [...keys].some((k) => used.has(k));

// How far a colorway's merchandising score may trail the style's best
// colorway and still stand in for it, so the cards don't all come out black.
// A colorway down to its last few sizes never stands in.
const COLOR_SWAP_SLACK = 0.3;

// Wide (or narrow) feet: the store also lists styles for them under "Helps
// with" (its helps_with field, or a tag like "Wide Feet") — shoes cut to fit
// those feet that aren't sold in a separate width. "" for other widths.
export function feetForWidth(width) {
  const w = lc(width);
  if (/\bwide\b|^x*w+$/.test(w)) return "wide";
  if (/\bnarrow\b|^n+$/.test(w)) return "narrow";
  return "";
}
export function helpsWithFeet(p, word) {
  if (!word) return false;
  const inHelps = new RegExp(`\\b${word}\\b`);
  const inTag = new RegExp(`\\b${word}[ -](feet|foot|fit|width)\\b`);
  return (p.conditions || []).some((c) => inHelps.test(lc(c))) || (p.tags || []).some((t) => inTag.test(lc(t)));
}

// One card per style, best first, up to limit. Each style's colorways in rank order.
function onePerStyle(ranked, { products, filters, ctx, limit, byPrice }) {
  const styles = new Map();
  for (const x of ranked) {
    const k = x.p.style.toLowerCase();
    if (!styles.has(k)) styles.set(k, []);
    styles.get(k).push(x);
  }
  // The style's best colorway, unless an earlier card already shows that
  // color: then another colorway that matches just as well and sells nearly
  // as well (black, white, navy, red… rather than black four times). Price
  // order keeps the cheapest colorway; colorful never swaps in a neutral.
  const used = new Set();
  const picked = [];
  for (const [k, list] of styles) {
    const best = list[0];
    let pick = best;
    if (!byPrice && sharesColor(colorKeys(best.p), used)) {
      pick = list.find((x) => x !== best && x.matched === best.matched && x.score === best.score && x.bright >= best.bright &&
        best.merch - x.merch <= COLOR_SWAP_SLACK && !fewSizesLeft(x.p) && !sharesColor(colorKeys(x.p), used)) || best;
    }
    for (const c of colorKeys(pick.p)) used.add(c);
    // The style's other colors that fit the same filters (size, width, price…).
    const others = products
      .filter((p) => p !== pick.p && p.style.toLowerCase() === k && passes(p, filters, ctx, "colors"))
      .map(colorwayName)
      .filter(Boolean);
    picked.push(toModelProduct(pick.p, { otherColors: [...new Set(others)] }));
    if (picked.length >= limit) break;
  }
  return picked;
}

export function leanSearch(catalog, params = {}) {
  const { products, ctx, filters, ranked, queryMatched } = rankMatches(catalog, params);
  const limit = Math.min(Math.max(Number(params.limit) || 6, 1), 10);
  const byPrice = String(params.sort || "best") !== "best";
  const picked = onePerStyle(ranked, { products, filters, ctx, limit, byPrice });

  const result = {
    total_matches: ranked.length,
    filters_applied: Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, ON_OFF.has(k) || k === "max_price" || k === "size" || k === "width" || k === "collection" ? v[0] : v])),
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
        products.filter((p) => passes(p, filters, ctx, key)).length,
      ]),
    );
  }
  // Asked for a wide (or narrow) width: after the styles sold in it, the
  // ones the store lists for those feet under "Helps with" — the same
  // search without the width — so the answer is never just one or two shoes.
  const word = filters.width ? feetForWidth(filters.width[0]) : "";
  if (word) {
    const inWidth = new Set(ranked.map((x) => x.p.style.toLowerCase()));
    const alt = rankMatches(catalog, { ...params, width: undefined }).ranked
      .filter((x) => !inWidth.has(x.p.style.toLowerCase()) && helpsWithFeet(x.p, word));
    if (alt.length) {
      const noWidth = Object.fromEntries(Object.entries(filters).filter(([k]) => k !== "width"));
      const label = `${word[0].toUpperCase()}${word.slice(1)} Feet`;
      result[`also_for_${word}_feet`] = {
        note: `Not sold in a separate ${word} width, but the store lists "${label}" under Helps with — made to fit ${word} feet. Offer these too, after the ones sold in ${word}, and say which is which.`,
        styles: new Set(alt.map((x) => x.p.style.toLowerCase())).size,
        products: onePerStyle(alt, { products, filters: noWidth, ctx, limit: Math.min(limit, 6), byPrice }),
      };
    }
  }
  return result;
}

// Every product a search result offers: its own, then the ones for wide
// (or narrow) feet that come with it.
export function resultHandles(result = {}) {
  const extra = Object.entries(result).filter(([k, v]) => /^also_for_\w+_feet$/.test(k) && Array.isArray(v?.products)).flatMap(([, v]) => v.products);
  return [...(result.products || []), ...extra].map((p) => p.handle);
}

// Every in-stock color of the styles the customer means (any colorway's
// handle names its style), each one a product that can be shown as a card.
// With a size or width, colors without it are listed apart so the answer
// can be honest ("in wide, the Carly comes in black only").
export function styleColorways(catalog, { handles = [], size, width } = {}) {
  const all = catalog?.products || [];
  const products = all.filter((p) => p.inStock);
  const byHandle = new Map(all.map((p) => [p.handle, p]));
  const ctx = filterContext(catalog, products);
  const filters = activeFilters({ size, width });
  const asked = Object.keys(filters).length > 0;
  const seenStyles = new Set();
  const styles = [];
  const unknown = [];
  for (const h of (Array.isArray(handles) ? handles : [handles]).map(String).slice(0, 6)) {
    const ref = byHandle.get(h);
    if (!ref) { unknown.push(h); continue; }
    const k = ref.style.toLowerCase();
    if (seenStyles.has(k)) continue;
    seenStyles.add(k);
    const sameLine = (p) => !ref.gender.length || !p.gender.length || p.gender.some((g) => ref.gender.includes(g) || g === "unisex");
    const ways = products.filter((p) => p.style.toLowerCase() === k && sameLine(p));
    const fits = ways.filter((p) => passes(p, filters, ctx));
    const color = (p) => ({
      handle: p.handle,
      color: colorwayName(p),
      price: p.priceLabel,
      ...(p.onSale ? { on_sale: true } : {}),
      ...(p.widths.length ? { widths_in_stock: p.widths } : {}),
      ...(fewSizesLeft(p) ? { few_sizes_left: true } : {}),
    });
    // Asked for wide (or narrow): the colors not sold in that width that the
    // store still lists for those feet under Helps with (in their size).
    const word = filters.width ? feetForWidth(filters.width[0]) : "";
    const forFeet = word ? ways.filter((p) => !fits.includes(p) && helpsWithFeet(p, word) && passes(p, filters, ctx, "width")) : [];
    styles.push({
      style: ref.style,
      colors: fits.map(color),
      ...(asked ? { colors_not_in_that_size_or_width: ways.filter((p) => !fits.includes(p)).map(colorwayName) } : {}),
      ...(forFeet.length ? { [`also_for_${word}_feet`]: forFeet.map(color) } : {}),
    });
  }
  return {
    ...(asked ? { filters_applied: { ...(filters.size ? { size: filters.size[0] } : {}), ...(filters.width ? { width: filters.width[0] } : {}) } } : {}),
    styles,
    ...(unknown.length ? { unknown_handles: unknown, note: "Unknown handles: search first." } : {}),
  };
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
    ...(Object.keys(specsOf(p)).length ? { specs: specsOf(p) } : {}),
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
