// Availability Truth — deterministic answer for workflow=availability.
//
// Exact availability questions ("Do you have the Jillian in black size 8?")
// must be answered from PRODUCT/VARIANT truth, not a generic semantic search.
// This module classifies a family + color/size/width request against the real
// variant inventory and produces one of four results plus the customer-facing
// answer text. It is PURE (imports only the pure variant-matcher) — the chat
// route fetches the family's products (with variants) from the DB and passes
// them in, so this whole module is unit-testable with fixtures.
//
// Results:
//   AVAILABLE      — product + requested color + size/width exists and in stock
//   UNAVAILABLE    — product exists, but the requested combo is known NOT available
//   UNKNOWN        — product exists, but variant inventory isn't exposed to verify
//   NOT_FOUND      — the named family/product isn't in the catalog
//   DISAMBIGUATION — the family token ("Jillian") matches MULTIPLE distinct
//                    styles (Jillian Braided vs Jillian Sport) and the request
//                    didn't name one — never silently pick; ask which.

// Variant normalization/inventory helpers are INLINED (kept in lockstep with
// variant-matcher.server.js) so this module has ZERO imports — that keeps it a
// clean, directly-importable server module (like turn-plan.server.js) and
// fully unit-testable with fixtures.
// Normalize an option bag to a flat { name: value } object. Accepts Shopify's
// selectedOptions ARRAY ([{name:"Size",value:"8"}, …] — the real synced shape),
// a plain object ({ Size:"8" }), or a JSON string of either. (Kept in lockstep
// with variant-matcher.server.js#normalizeOptionBag.)
function normalizeOptionBag(raw) {
  let v = raw;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return {}; } }
  if (!v || typeof v !== "object") return {};
  if (Array.isArray(v)) {
    const bag = {};
    for (const o of v) {
      if (o && typeof o === "object" && o.name != null) bag[String(o.name)] = o.value;
    }
    return bag;
  }
  return v;
}
function readBagCI(bag, key) {
  if (!bag || typeof bag !== "object") return undefined;
  const target = String(key).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  for (const [k, v] of Object.entries(bag)) {
    const norm = String(k).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (norm === target) return v;
  }
  return undefined;
}
function readVariantOption(variant, key) {
  const fromOptions = readBagCI(normalizeOptionBag(variant?.optionsJson), key);
  if (fromOptions != null && fromOptions !== "") return fromOptions;
  return readBagCI(normalizeOptionBag(variant?.attributesJson), key);
}
function normalizeVariantSize(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  // Aetrex labels carry a "US" suffix ("8 US") and sometimes a range
  // ("9 - 9.5 US") — strip the unit; for a range, normalize to the FIRST size
  // (callers that need the whole range use expandVariantSizes).
  s = s.replace(/\bus\b/gi, " ").replace(/^size\s+/i, "").replace(/\s*½/g, ".5").replace(/\s+1\/2/g, ".5").trim();
  const range = s.match(/^(\d{1,2}(?:\.\d)?)\s*[-–—]\s*\d/);
  if (range) return range[1];
  const m = s.match(/^(\d{1,2}(?:\.\d)?)\s*[wnm](?:\b|$)/i);
  if (m) return m[1];
  s = s.replace(/\s*(wide|narrow|medium|regular|standard)\s*$/i, "").trim();
  if (/^\d{1,2}(?:\.\d)?$/.test(s)) return s;
  return s || null;
}
// Expand a variant Size label into the SET of normalized sizes it covers. A
// plain "8 US" → ["8"]; a range "9 - 9.5 US" → ["9","9.5"]; "7.5 - 8 US" →
// ["7.5","8"]. Availability matching uses this so a request for "9" matches a
// "9 - 9.5 US" variant.
function expandVariantSizes(raw) {
  if (raw == null) return [];
  let s = String(raw).trim().toLowerCase();
  if (!s) return [];
  s = s.replace(/\bus\b/gi, " ").replace(/^size\s+/i, "").replace(/\s*½/g, ".5").replace(/\s+1\/2/g, ".5").trim();
  s = s.replace(/\s*(wide|narrow|medium|regular|standard)\s*$/i, "").trim();
  const range = s.match(/^(\d{1,2}(?:\.\d)?)\s*[-–—]\s*(\d{1,2}(?:\.\d)?)/);
  if (range) {
    let lo = parseFloat(range[1]);
    let hi = parseFloat(range[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      if (hi < lo) { const t = lo; lo = hi; hi = t; }
      const out = [];
      for (let x = lo; x <= hi + 1e-9; x += 0.5) {
        out.push(x % 1 === 0 ? String(x) : x.toFixed(1));
      }
      return out;
    }
  }
  const one = normalizeVariantSize(s);
  return one ? [one] : [];
}
function normalizeVariantWidth(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim();
  if (!s) return null;
  const combo = s.match(/^\d{1,2}(?:\.\d)?\s*([wnm])\b/i);
  if (combo) { const w = combo[1].toLowerCase(); return w === "w" ? "wide" : w === "n" ? "narrow" : "medium"; }
  if (/\b(extra[-\s]?wide|xw|wide|w)\b/.test(s) && !/medium/.test(s)) return "wide";
  if (/\b(narrow|slim|n)\b/.test(s)) return "narrow";
  if (/\b(medium|regular|standard|m|b)\b/.test(s)) return "medium";
  return null;
}
function variantIsAvailable(variant) {
  const q = variant?.inventoryQty;
  if (q == null) return true; // untracked → treated as available
  return Number(q) > 0;
}
function inStockSizes(product, { width = null } = {}) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const wantedWidth = normalizeVariantWidth(width);
  const out = new Set();
  for (const v of variants) {
    if (!variantIsAvailable(v)) continue;
    if (wantedWidth) {
      const vWidth = normalizeVariantWidth(readVariantOption(v, "Width")) || normalizeVariantWidth(readVariantOption(v, "Fit"));
      if (vWidth && vWidth !== wantedWidth) continue;
    }
    for (const s of expandVariantSizes(readVariantOption(v, "Size"))) out.add(s);
  }
  return Array.from(out);
}
function inStockWidths(product, { size = null } = {}) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const wantedSize = normalizeVariantSize(size);
  const out = new Set();
  for (const v of variants) {
    if (!variantIsAvailable(v)) continue;
    if (wantedSize) {
      if (!expandVariantSizes(readVariantOption(v, "Size")).includes(wantedSize)) continue;
    }
    const w = normalizeVariantWidth(readVariantOption(v, "Width")) || normalizeVariantWidth(readVariantOption(v, "Fit"));
    if (w) out.add(w);
  }
  return Array.from(out);
}
function isSizeAvailable(product, size, { width = null } = {}) {
  const canonicalSize = normalizeVariantSize(size);
  if (!canonicalSize) return false;
  return inStockSizes(product, { width }).includes(canonicalSize);
}
// Does ANY variant of the product expose a width option at all? widths=[]
// everywhere means width simply isn't tracked in selectedOptions — a "size 7
// wide" request can't be width-verified even if size 7 exists.
function productHasWidthData(product) {
  for (const v of product?.variants || []) {
    const w = normalizeVariantWidth(readVariantOption(v, "Width")) || normalizeVariantWidth(readVariantOption(v, "Fit"));
    if (w) return true;
  }
  return false;
}

export const AVAILABILITY_RESULT = {
  AVAILABLE: "AVAILABLE",
  UNAVAILABLE: "UNAVAILABLE",
  UNKNOWN: "UNKNOWN",
  NOT_FOUND: "NOT_FOUND",
  DISAMBIGUATION: "DISAMBIGUATION",
};

// Minimal family token (kept consistent with titleStyleFamily): the first
// meaningful word before a " - color" suffix. Inlined so this module stays
// prisma-free and the eval runs in any repo.
const FAMILY_STOPWORDS = new Set([
  "the", "aetrex", "womens", "women", "mens", "men", "kids", "unisex",
  "new", "classic", "comfort", "premium", "pro",
]);
export function familyOfTitle(title) {
  if (!title) return "";
  const beforeDash = String(title).split(/\s[-–—]\s/)[0];
  const words = beforeDash.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (w.length > 2 && !FAMILY_STOPWORDS.has(w)) return w;
  }
  return "";
}

// Generic category nouns — dropped from a STYLE key so they don't masquerade as
// a style differentiator ("Sandal" is common to every Jillian style).
const STYLE_CATEGORY_WORDS = new Set([
  "sandal", "sandals", "sneaker", "sneakers", "shoe", "shoes", "boot", "boots",
  "slide", "slides", "clog", "clogs", "flat", "flats", "loafer", "loafers",
  "mule", "mules", "wedge", "wedges", "heel", "heels", "slipper", "slippers",
  "bootie", "booties", "oxford", "oxfords", "moccasin", "moccasins", "sock", "socks",
]);

// A STYLE is a specific product line within a family. The family token
// "jillian" can cover several styles — "Jillian Braided …", "Jillian Sport …".
// styleKeyOfTitle is the normalized key used to GROUP/MATCH styles (family
// stopwords + generic category nouns removed); styleNameOfTitle is the human
// display name (the product title minus the trailing color suffix).
//   "Jillian Braided Quarter Strap Sandal - Black" → key "jillian braided quarter strap"
//   "Jillian Sport Sandal - Black"                 → key "jillian sport"
export function styleKeyOfTitle(title) {
  if (!title) return "";
  const beforeDash = String(title).split(/\s[-–—]\s/)[0];
  const words = beforeDash.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !STYLE_CATEGORY_WORDS.has(w) && !FAMILY_STOPWORDS.has(w));
  return kept.join(" ");
}
export function styleNameOfTitle(title) {
  return String(title || "").split(/\s[-–—]\s/)[0].trim();
}

// Built-in footwear colors so champagne/bronze/taupe parse even when the
// merchant color lexicon misses them. The caller also passes knownColors
// (colors mined from the named family's product titles/variants) — so a color
// that only appears in the catalog ("Savannah ... Champagne") still counts.
const BUILTIN_COLORS = [
  "black", "white", "ivory", "cream", "off-white", "off white", "bone",
  "navy", "blue", "denim", "teal", "turquoise",
  "red", "burgundy", "wine", "maroon", "pink", "blush", "rose", "fuchsia", "coral",
  "green", "olive", "sage", "mint",
  "tan", "beige", "nude", "taupe", "khaki", "sand", "stone",
  "brown", "chocolate", "cognac", "espresso", "mocha", "camel", "chestnut",
  "bronze", "copper", "gold", "silver", "pewter", "metallic",
  "grey", "gray", "charcoal", "smoke", "graphite", "slate",
  "champagne", "blush", "mauve", "lavender", "purple", "eggplant", "plum",
  "yellow", "mustard", "orange", "cognac", "leopard", "snake", "floral",
];
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// The color a product title ends with ("Savannah ... - Champagne" → "champagne").
export function colorFromTitle(title) {
  const parts = String(title || "").split(/\s[-–—]\s/);
  if (parts.length < 2) return "";
  return parts[parts.length - 1].trim().toLowerCase();
}

// Loose intent: did the customer's message MENTION a color / size / width at
// all? Used to refuse a false AVAILABLE when a requested constraint couldn't be
// normalized ("size 7 wide" present but unparsed → UNKNOWN, not AVAILABLE).
const SIZE_INTENT_RE = /\b(?:size\s+\d|in\s+(?:an?\s+)?\d{1,2}(?:\.5)?\b|\b\d{1,2}(?:\.5)?\s*(?:wide|narrow|medium|w|n|m)\b|\bsize\b|what\s+about\s+(?:an?\s+)?\d)/i;
const WIDTH_INTENT_RE = /\b(wide|narrow|medium|extra[-\s]?wide|x-?wide|xw|\bw\b|\bn\b|\bm\b)\b/i;
export function constraintIntent(message, knownColors = []) {
  const m = String(message || "").toLowerCase();
  const colorList = [...BUILTIN_COLORS, ...(knownColors || []).map((c) => String(c).toLowerCase())];
  const color = colorList.some((c) => new RegExp(`\\b${escapeRe(c)}\\b`).test(m));
  const size = SIZE_INTENT_RE.test(m);
  // width intent only if a real width word appears in a size/width context
  const width = /\b(extra[-\s]?wide|x-?wide|xw|wide|narrow)\b/i.test(m) || /\b\d{1,2}(?:\.5)?\s*(?:wide|narrow|w|n)\b/i.test(m);
  return { color, size, width };
}

// Parse color / size / width directly from the raw message. Robust to the
// phrasings customers actually use ("in black size 8", "in an 8", "what about
// 9", "7 wide", "size 8.5"). Returns normalized values (size as a string like
// "8" / "8.5"; width as wide|narrow|medium).
export function parseAvailabilityConstraints(message, knownColors = []) {
  const m = String(message || "").toLowerCase();

  // Color: first builtin/known color that appears as a whole word.
  let color = null;
  const colorList = [...(knownColors || []).map((c) => String(c).toLowerCase()), ...BUILTIN_COLORS];
  for (const c of colorList) {
    if (c && new RegExp(`\\b${escapeRe(c)}\\b`).test(m)) { color = c; break; }
  }

  // Width.
  let width = null;
  if (/\b(extra[-\s]?wide|x-?wide|xw)\b/i.test(m)) width = "wide";
  else if (/\bwide\b/i.test(m)) width = "wide";
  else if (/\bnarrow\b/i.test(m)) width = "narrow";
  else if (/\b(medium|regular|standard)\s+width\b/i.test(m)) width = "medium";

  // Size: try size-context patterns, in priority order. Range 4–14 keeps real
  // shoe sizes and rejects "$100" / "10 miles" (those aren't size-context).
  let size = null;
  const sizePatterns = [
    /\bsize\s+(\d{1,2}(?:\.5)?)\b/i,
    /\bwhat\s+about\s+(?:an?\s+|a\s+)?(\d{1,2}(?:\.5)?)\b/i,
    /\b(?:in|get|wear|do\s+you\s+have|they\s+have|have)\s+(?:an?\s+|a\s+)?(\d{1,2}(?:\.5)?)\b/i,
    /\b(\d{1,2}(?:\.5)?)\s*(?:wide|narrow|medium|w|n|m)\b/i,
  ];
  for (const re of sizePatterns) {
    const mm = m.match(re);
    if (mm) {
      const n = parseFloat(mm[1]);
      if (n >= 4 && n <= 14) { size = mm[1].replace(/^(\d+)$/, "$1"); break; }
    }
  }
  // "7 wide" already captured size via the width-context pattern; if width is
  // set but size still null, also peel a bare "N wide".
  if (!size && width) {
    const mm = m.match(/\b(\d{1,2}(?:\.5)?)\s*(?:wide|narrow|w|n)\b/i);
    if (mm) { const n = parseFloat(mm[1]); if (n >= 4 && n <= 14) size = mm[1]; }
  }

  return { color, size, width };
}

// Resolve the availability REQUEST from CURRENT-turn signals only. Constraints
// are parsed from the latest message (with the family's knownColors). A deictic
// / "what about" follow-up that names no new family inherits family + color
// from the focus product, and inherits color/size/width it didn't restate from
// the PRIOR availability message. Stale session memory is NEVER consulted.
export function resolveAvailabilityRequest({ message = "", priorMessage = "", priorConstraints = null, namedFamilies = [], focusProduct = null, isFollowUp = false, knownColors = [] } = {}) {
  const cur = parseAvailabilityConstraints(message, knownColors);

  let family = (namedFamilies && namedFamilies[0]) || null;
  if (!family && isFollowUp && focusProduct) family = familyOfTitle(focusProduct.title || "");

  let color = cur.color;
  let size = cur.size;
  let width = cur.width;

  if (isFollowUp && family) {
    // Prefer the ACCUMULATED prior constraints (most-recent value per field
    // across all prior availability turns) so a color-only follow-up
    // ("and in black?") still inherits a size set two turns back
    // ("what about size 8?"). Fall back to the single prior message.
    const prior = priorConstraints || parseAvailabilityConstraints(priorMessage, knownColors);
    const focusColor = focusProduct ? colorFromTitle(focusProduct.title || "") : "";
    // New explicit value replaces prior; otherwise inherit prior availability.
    if (!color) color = focusColor || prior.color || null;
    if (!size) size = prior.size || null;
    if (!width) width = prior.width || null;
  }

  return { family, color, size, width };
}

// Accumulate the most-recent prior availability constraints across ALL prior
// user turns (most-recent value wins per field). A color-only follow-up
// ("and in black?") must still inherit the size set two turns ago
// ("what about size 8?") — a single-prior-message lookup loses it when the
// immediately-prior turn restated only one field. The current (last) user
// message is excluded.
export function priorAvailabilityConstraints(messages = [], knownColors = []) {
  const users = (Array.isArray(messages) ? messages : []).filter((m) => m?.role === "user").map(messageText).filter(Boolean);
  const priors = users.slice(0, -1);
  const acc = { color: null, size: null, width: null };
  for (let i = priors.length - 1; i >= 0; i--) {
    const c = parseAvailabilityConstraints(priors[i], knownColors);
    if (!acc.color && c.color) acc.color = c.color;
    if (!acc.size && c.size) acc.size = c.size;
    if (!acc.width && c.width) acc.width = c.width;
    if (acc.color && acc.size && acc.width) break;
  }
  return acc;
}

// Pull the customer-facing text out of a conversation message (string content
// or Anthropic content blocks). Tool-result/array blocks with no text → "".
function messageText(m) {
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) return m.content.filter((b) => b?.type === "text" && b.text).map((b) => b.text).join(" ");
  return "";
}

// The most recent PRIOR user message that looks like an availability question
// (names a size/width/color) — the one a follow-up ("what about size 9?")
// should inherit from. Scans backwards so intervening non-availability turns
// don't hide it; the current message (last user turn) is excluded.
export function priorAvailabilityMessage(messages = [], knownColors = []) {
  const users = (Array.isArray(messages) ? messages : []).filter((m) => m?.role === "user").map(messageText).filter(Boolean);
  const priors = users.slice(0, -1);
  for (let i = priors.length - 1; i >= 0; i--) {
    const c = parseAvailabilityConstraints(priors[i], knownColors);
    if (c.size || c.width || c.color) return priors[i];
  }
  return priors[priors.length - 1] || "";
}

const FOLLOWUP_RE = /\b(this one|that one|these|those|\bit\b|\bthis\b|\bthat\b|what\s+about|how\s+about|and\s+in\b|do\s+they\s+have)\b/i;
export function isAvailabilityFollowUp(message) {
  return FOLLOWUP_RE.test(String(message || ""));
}

function variantColor(v) {
  for (const bag of [normalizeOptionBag(v?.optionsJson), normalizeOptionBag(v?.attributesJson)]) {
    for (const [k, val] of Object.entries(bag)) {
      if (/colou?r/i.test(k) && val) return String(val).toLowerCase().trim();
    }
  }
  return "";
}
function productColors(product) {
  const set = new Set();
  const title = String(product?.title || "").toLowerCase();
  const dash = title.split(/\s[-–—]\s/);
  if (dash.length > 1) set.add(dash[dash.length - 1].trim());
  // Also scan the WHOLE title for any known color word so a color that isn't a
  // " - Color" suffix still surfaces ("Jillian Sport Rose Sandal" → rose). This
  // is what lets the soft-color match find Rose when "pink" is requested even
  // when the variants carry no Color option.
  for (const c of BUILTIN_COLORS) {
    if (new RegExp(`\\b${escapeRe(c)}\\b`).test(title)) set.add(c);
  }
  for (const v of product?.variants || []) {
    const c = variantColor(v);
    if (c) set.add(c);
  }
  return set;
}
function productMatchesColor(product, color) {
  if (!color) return true;
  const want = String(color).toLowerCase().trim();
  for (const c of productColors(product)) {
    if (c === want || c.includes(want) || want.includes(c)) return true;
  }
  return String(product?.title || "").toLowerCase().includes(want);
}

// Soft color families — a shopper word maps to close catalog colors so we
// surface the real product instead of falsely denying it ("pink" → Rose).
// champagne intentionally has NO family (it stays exact).
const COLOR_FAMILIES = [
  ["pink", "rose", "blush", "mauve", "fuchsia", "magenta", "rosegold", "rose gold"],
  ["grey", "gray", "charcoal", "slate", "graphite", "pewter", "smoke"],
  ["tan", "beige", "nude", "sand", "khaki", "camel", "stone", "taupe"],
  ["brown", "chocolate", "cognac", "espresso", "mocha", "chestnut"],
  ["navy", "blue", "denim", "indigo", "cobalt"],
  ["white", "ivory", "cream", "off-white", "off white", "bone"],
  ["red", "burgundy", "wine", "maroon", "crimson"],
  ["gold", "bronze", "copper", "metallic"],
  ["green", "olive", "sage", "mint", "emerald"],
  ["purple", "plum", "eggplant", "lavender", "violet"],
  ["black", "noir", "onyx"],
];
function colorFamilyOf(color) {
  const w = String(color || "").toLowerCase().trim();
  for (const fam of COLOR_FAMILIES) if (fam.includes(w)) return fam;
  return null;
}
// If reqColor isn't carried but a close same-family color is, return that
// catalog color so we say "I don't see Pink, but it's available in Rose".
function softColorMatch(reqColor, products) {
  const fam = colorFamilyOf(reqColor);
  if (!fam) return null;
  for (const p of products) {
    for (const c of productColors(p)) {
      const cw = c.toLowerCase().trim();
      if (cw !== String(reqColor).toLowerCase().trim() && fam.includes(cw)) return { product: p, matchedColor: cw };
    }
  }
  return null;
}
function productHasInStockVariant(product) {
  return (product?.variants || []).some((v) => {
    const q = v?.inventoryQty;
    return q == null || Number(q) > 0;
  });
}

// All colors carried by a set of products (titles + variant Color options).
// The caller passes the named family's products so the parser can recognize a
// catalog-only color ("champagne") the merchant lexicon misses.
export function collectFamilyColors(products = []) {
  const set = new Set();
  for (const p of products || []) for (const c of productColors(p)) if (c) set.add(c);
  return Array.from(set);
}

// Diagnostics for the [availability-truth] log so a parser bug is instantly
// distinguishable from genuinely-missing variant data: how many variants the
// family has, whether optionsJson is the Shopify array shape or an object, and
// the in-stock sizes/widths the reader actually extracts.
export function variantDataDiagnostics(products = [], family = "") {
  const fam = String(family || "").toLowerCase();
  const fp = (products || []).filter((p) => familyOfTitle(p?.title || "") === fam);
  let variants = 0;
  let optionShape = "none";
  for (const p of fp) {
    for (const v of p?.variants || []) {
      variants++;
      let raw = v?.optionsJson;
      if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = null; } }
      if (Array.isArray(raw)) optionShape = "array";
      else if (raw && typeof raw === "object" && optionShape === "none") optionShape = "object";
    }
  }
  const sizes = new Set();
  const widths = new Set();
  for (const p of fp) {
    for (const s of inStockSizes(p)) sizes.add(s);
    for (const w of inStockWidths(p)) widths.add(w);
  }
  return { variants, optionShape, sizes: Array.from(sizes), widths: Array.from(widths) };
}

// Resolve which STYLE the customer means among color-filtered candidates.
// Returns { candidates } narrowed to one style, or { ambiguous: [styleEntry] }
// when the family token covers multiple styles and the request named none.
// A style is "named" when one of its DISTINGUISHING words (the words unique to
// it among the styles, excluding the family token and words common to all
// styles) appears in the query, or when it equals the prior focus style.
function disambiguateStyle(candidates, fam, styleQuery, focusStyleKey) {
  const byStyle = new Map();
  for (const p of candidates) {
    const key = styleKeyOfTitle(p.title || "");
    if (!byStyle.has(key)) byStyle.set(key, { key, name: styleNameOfTitle(p.title || ""), products: [] });
    byStyle.get(key).products.push(p);
  }
  if (byStyle.size <= 1) return { candidates };

  const entries = Array.from(byStyle.values());
  let common = null;
  for (const st of entries) {
    const ws = new Set(st.key.split(/\s+/).filter(Boolean));
    common = common == null ? ws : new Set([...common].filter((w) => ws.has(w)));
  }
  const famWords = new Set(String(fam).split(/\s+/).filter(Boolean));
  const q = String(styleQuery || "").toLowerCase();
  const fk = focusStyleKey ? String(focusStyleKey).toLowerCase() : null;

  const matched = [];
  for (const st of entries) {
    st.extra = st.key.split(/\s+/).filter((w) => w && !common.has(w) && !famWords.has(w));
    const named =
      (st.extra.length > 0 && st.extra.some((w) => new RegExp(`\\b${escapeRe(w)}\\b`).test(q))) ||
      (fk && st.key === fk);
    if (named) matched.push(st);
  }
  if (matched.length === 1) return { candidates: matched[0].products };
  // None named → ambiguous across all styles; several named → ambiguous across
  // just those (e.g. "Sport" narrows to Sport Mesh + Sport Knit, then asks).
  return { ambiguous: matched.length > 1 ? matched : entries };
}

// Classify availability for a single family request. `products` is the set of
// catalog products (any family) — we filter to the named family ourselves so
// the caller can pass a broad fetch. `unverifiedConstraints` is a list of
// constraint names the customer DID request in text but we couldn't normalize
// — when the product exists, that forces UNKNOWN (never a false AVAILABLE).
// `styleQuery` (raw request text) + `focusStyleKey` (prior focus product's
// style key) drive style disambiguation when the family covers multiple styles.
export function classifyAvailability({ products = [], family = "", color = null, size = null, width = null, unverifiedConstraints = [], styleQuery = "", focusStyleKey = null } = {}) {
  const fam = String(family || "").toLowerCase();
  const reqColor = color ? String(color).toLowerCase().trim() : null;
  const sz = normalizeVariantSize(size);
  const wd = normalizeVariantWidth(width);

  const famProducts = (products || []).filter((p) => familyOfTitle(p?.title || "") === fam);
  if (famProducts.length === 0) {
    return { result: AVAILABILITY_RESULT.NOT_FOUND, product: null, family: fam, color: reqColor, size: sz, width: wd, reason: "family_not_found" };
  }

  // B. The customer asked for a size/width/color we couldn't parse — the family
  // exists but we can't verify the exact combo. Never claim AVAILABLE.
  if (Array.isArray(unverifiedConstraints) && unverifiedConstraints.length > 0) {
    let cands = famProducts;
    if (reqColor) {
      const cm = famProducts.filter((p) => productMatchesColor(p, reqColor));
      if (cm.length > 0) cands = cm;
    }
    return { result: AVAILABILITY_RESULT.UNKNOWN, product: cands[0], family: fam, color: reqColor, size: sz, width: wd, reason: "unparsed_requested_constraints" };
  }

  // Verdict builder — every return carries the resolved fields + soft-color.
  let softColor = false;
  let matchedColor = null;
  const mk = (result, product, reason, extra = {}) => ({
    result, product: product || null, family: fam, color: reqColor, size: sz, width: wd,
    softColor, matchedColor, reason, ...extra,
  });

  // Color filter — the family exists; is the requested color carried? If not,
  // try a soft color-family match (pink → Rose) before denying it.
  let candidates = famProducts;
  if (reqColor) {
    const colorMatched = famProducts.filter((p) => productMatchesColor(p, reqColor));
    if (colorMatched.length > 0) {
      candidates = colorMatched;
    } else {
      const soft = softColorMatch(reqColor, famProducts);
      if (soft) {
        softColor = true;
        matchedColor = soft.matchedColor;
        candidates = famProducts.filter((p) => productMatchesColor(p, soft.matchedColor));
      } else {
        return mk(AVAILABILITY_RESULT.UNAVAILABLE, famProducts[0], "color_not_carried");
      }
    }
  }

  // Style disambiguation — the family token may cover multiple distinct styles
  // (Jillian Braided vs Jillian Sport). If the request didn't name one (and the
  // prior focus doesn't pin one), ask which — never silently pick. Runs AFTER
  // the color filter, so we only disambiguate among styles that carry the
  // requested/soft color.
  const dis = disambiguateStyle(candidates, fam, styleQuery, focusStyleKey);
  if (dis.ambiguous) {
    return {
      result: AVAILABILITY_RESULT.DISAMBIGUATION,
      product: dis.ambiguous[0].products[0],
      products: dis.ambiguous.flatMap((s) => s.products),
      styles: dis.ambiguous.map((s) => s.name),
      family: fam, color: reqColor, size: sz, width: wd,
      softColor, matchedColor, reason: "multiple_styles",
    };
  }
  candidates = dis.candidates;

  // Color/family only (no size/width) — is any candidate in stock?
  if (!sz && !wd) {
    const available = candidates.some(productHasInStockVariant);
    return mk(
      available ? AVAILABILITY_RESULT.AVAILABLE : AVAILABILITY_RESULT.UNAVAILABLE,
      candidates[0],
      available ? (softColor ? "soft_color_match" : null) : "out_of_stock",
    );
  }

  // Width requested but the family has NO width option anywhere → width can't
  // be verified. Split the answer: confirm the SIZE if it exists, but be honest
  // that width isn't a tracked option.
  if (wd && !candidates.some(productHasWidthData)) {
    const sizeOk = sz ? candidates.some((p) => isSizeAvailable(p, sz)) : true;
    if (sizeOk) {
      return mk(AVAILABILITY_RESULT.UNKNOWN, candidates[0], "width_not_in_options", { sizeAvailable: Boolean(sz) });
    }
    const anySizes = candidates.some((p) => inStockSizes(p).length > 0);
    return anySizes
      ? mk(AVAILABILITY_RESULT.UNAVAILABLE, candidates[0], "size_not_carried")
      : mk(AVAILABILITY_RESULT.UNKNOWN, candidates[0], "no_variant_inventory");
  }

  // Size/width — find a satisfying in-stock variant across the candidates.
  for (const p of candidates) {
    const okSize = sz ? isSizeAvailable(p, sz, { width: wd }) : true;
    const okWidth = wd && !sz ? inStockWidths(p).includes(wd) : true;
    if (okSize && okWidth) {
      return mk(AVAILABILITY_RESULT.AVAILABLE, p, softColor ? "soft_color_match" : null);
    }
  }
  // Not found in stock. UNKNOWN when NO variant inventory is exposed at all
  // (untracked / unsynced); UNAVAILABLE when sizes/widths ARE known but the
  // requested combo isn't among them.
  const anyVariantData = candidates.some((p) => inStockSizes(p).length > 0 || inStockWidths(p).length > 0);
  if (!anyVariantData) return mk(AVAILABILITY_RESULT.UNKNOWN, candidates[0], "no_variant_inventory");
  return mk(AVAILABILITY_RESULT.UNAVAILABLE, candidates[0], "variant_not_carried");
}

function titleCase(s) {
  return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}
function familyName(verdict) {
  // Prefer the real product's family token, title-cased ("jillian" → "Jillian").
  return titleCase(verdict?.family || familyOfTitle(verdict?.product?.title || "") || "");
}
function comboPhrase({ color, size, width }) {
  const parts = [];
  if (color) parts.push(titleCase(color));
  if (size) parts.push(`size ${size}`);
  if (width) parts.push(`${width} width`);
  return parts.join(", ");
}
function sizeWidthPhrase({ size, width }) {
  const parts = [];
  if (size) parts.push(`size ${size}`);
  if (width) parts.push(width);
  return parts.join(" ") || "that exact option";
}

// Customer-facing answer text per the availability contract. No "take a look",
// no "tell me more", no alternatives.
export function buildAvailabilityAnswer(verdict) {
  const name = familyName(verdict);

  // Multiple styles under one family token — ask which, never pick one. Fold in
  // the soft-color note when the requested color mapped to a catalog color.
  if (verdict.result === AVAILABILITY_RESULT.DISAMBIGUATION) {
    const styles = (verdict.styles || []).filter(Boolean);
    const joined =
      styles.length <= 1 ? (styles[0] || `${name} style`)
      : styles.length === 2 ? `the ${styles[0]} or the ${styles[1]}`
      : styles.slice(0, -1).map((s) => `the ${s}`).join(", ") + `, or the ${styles[styles.length - 1]}`;
    if (verdict.softColor && verdict.matchedColor) {
      return `I don't see a color called ${titleCase(verdict.color)}, but a few ${name} styles come in ${titleCase(verdict.matchedColor)}. Did you mean ${joined}?`;
    }
    return `We carry more than one ${name} style. Did you mean ${joined}?`;
  }

  // Soft color match: requested color isn't carried, but a same-family catalog
  // color is. Never claim the literal requested color — surface the real one.
  if (verdict.softColor && verdict.matchedColor && verdict.result === AVAILABILITY_RESULT.AVAILABLE) {
    const got = titleCase(verdict.matchedColor);
    const sizePart = verdict.size ? ` in size ${verdict.size}` : "";
    return `I don't see a color called ${titleCase(verdict.color)}, but the ${name} is available in ${got}${sizePart}.`;
  }

  // Width requested but not a tracked option: confirm the size, be honest
  // about width.
  if (verdict.reason === "width_not_in_options") {
    if (verdict.sizeAvailable && verdict.size) {
      return (
        `I can find the ${name}${verdict.color ? ` in ${titleCase(verdict.color)}` : ""} in size ${verdict.size}, ` +
        `but I don't see ${titleCase(verdict.width || "that")} listed as a separate width option in the data.`
      );
    }
    return (
      `I can find the ${name}${verdict.color ? ` in ${titleCase(verdict.color)}` : ""}, but I don't see ` +
      `${titleCase(verdict.width || "that width")} listed as a separate width option in the data.`
    );
  }

  const combo = comboPhrase(verdict);
  switch (verdict.result) {
    case AVAILABILITY_RESULT.AVAILABLE:
      return `Yes — the ${name} is available${combo ? ` in ${combo}` : ""}.`;
    case AVAILABILITY_RESULT.UNAVAILABLE:
      // "size not carried" → name the size plainly.
      if (verdict.reason === "size_not_carried" && verdict.size) {
        return `I'm not seeing the ${name}${verdict.color ? ` in ${titleCase(verdict.color)}` : ""} in size ${verdict.size}.`;
      }
      return `I'm not seeing the ${name} available${combo ? ` in ${combo}` : ""} right now.`;
    case AVAILABILITY_RESULT.UNKNOWN:
      return (
        `I can find the ${name}${verdict.color ? ` in ${titleCase(verdict.color)}` : ""}, ` +
        `but I can't verify ${sizeWidthPhrase(verdict)} from the data I have here. ` +
        `Open the product page to confirm current size availability.`
      );
    case AVAILABILITY_RESULT.NOT_FOUND:
    default:
      return `I'm not finding that exact ${name || "product"} style in the catalog right now.`;
  }
}
