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
//   AVAILABLE   — product + requested color + size/width exists and is in stock
//   UNAVAILABLE — product exists, but the requested combo is known NOT available
//   UNKNOWN     — product exists, but variant inventory isn't exposed to verify
//   NOT_FOUND   — the named family/product isn't in the catalog

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
  s = s.replace(/^size\s+/i, "").replace(/\s*½/g, ".5").replace(/\s+1\/2/g, ".5");
  const m = s.match(/^(\d{1,2}(?:\.\d)?)\s*[wnm](?:\b|$)/i);
  if (m) return m[1];
  s = s.replace(/\s*(wide|narrow|medium|regular|standard)\s*$/i, "").trim();
  if (/^\d{1,2}(?:\.\d)?$/.test(s)) return s;
  return s || null;
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
    const s = normalizeVariantSize(readVariantOption(v, "Size"));
    if (s) out.add(s);
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
      const vSize = normalizeVariantSize(readVariantOption(v, "Size"));
      if (vSize !== wantedSize) continue;
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

export const AVAILABILITY_RESULT = {
  AVAILABLE: "AVAILABLE",
  UNAVAILABLE: "UNAVAILABLE",
  UNKNOWN: "UNKNOWN",
  NOT_FOUND: "NOT_FOUND",
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
export function resolveAvailabilityRequest({ message = "", priorMessage = "", namedFamilies = [], focusProduct = null, isFollowUp = false, knownColors = [] } = {}) {
  const cur = parseAvailabilityConstraints(message, knownColors);

  let family = (namedFamilies && namedFamilies[0]) || null;
  if (!family && isFollowUp && focusProduct) family = familyOfTitle(focusProduct.title || "");

  let color = cur.color;
  let size = cur.size;
  let width = cur.width;

  if (isFollowUp && family) {
    const prior = parseAvailabilityConstraints(priorMessage, knownColors);
    const focusColor = focusProduct ? colorFromTitle(focusProduct.title || "") : "";
    // New explicit value replaces prior; otherwise inherit prior availability.
    if (!color) color = focusColor || prior.color || null;
    if (!size) size = prior.size || null;
    if (!width) width = prior.width || null;
  }

  return { family, color, size, width };
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
  const dash = String(product?.title || "").split(/\s[-–—]\s/);
  if (dash.length > 1) set.add(dash[dash.length - 1].trim().toLowerCase());
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

// Classify availability for a single family request. `products` is the set of
// catalog products (any family) — we filter to the named family ourselves so
// the caller can pass a broad fetch. `unverifiedConstraints` is a list of
// constraint names the customer DID request in text but we couldn't normalize
// — when the product exists, that forces UNKNOWN (never a false AVAILABLE).
export function classifyAvailability({ products = [], family = "", color = null, size = null, width = null, unverifiedConstraints = [] } = {}) {
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

  // Color filter — the family exists; is the requested color carried?
  let candidates = famProducts;
  if (reqColor) {
    const colorMatched = famProducts.filter((p) => productMatchesColor(p, reqColor));
    if (colorMatched.length === 0) {
      return { result: AVAILABILITY_RESULT.UNAVAILABLE, product: famProducts[0], family: fam, color: reqColor, size: sz, width: wd, reason: "color_not_carried" };
    }
    candidates = colorMatched;
  }

  // Color/family only (no size/width) — is any candidate in stock?
  if (!sz && !wd) {
    const available = candidates.some(productHasInStockVariant);
    return {
      result: available ? AVAILABILITY_RESULT.AVAILABLE : AVAILABILITY_RESULT.UNAVAILABLE,
      product: candidates[0], family: fam, color: reqColor, size: sz, width: wd,
      reason: available ? null : "out_of_stock",
    };
  }

  // Size/width — find a satisfying in-stock variant across the candidates.
  for (const p of candidates) {
    const okSize = sz ? isSizeAvailable(p, sz, { width: wd }) : true;
    const okWidth = wd && !sz ? inStockWidths(p).includes(wd) : true;
    if (okSize && okWidth) {
      return { result: AVAILABILITY_RESULT.AVAILABLE, product: p, family: fam, color: reqColor, size: sz, width: wd, reason: null };
    }
  }
  // Not found in stock. UNKNOWN when NO variant inventory is exposed at all
  // (untracked / unsynced) — we genuinely can't verify; UNAVAILABLE when the
  // product DOES expose sizes/widths but the requested combo isn't among them.
  const anyVariantData = candidates.some((p) => inStockSizes(p).length > 0 || inStockWidths(p).length > 0);
  const product = candidates[0];
  if (!anyVariantData) {
    return { result: AVAILABILITY_RESULT.UNKNOWN, product, family: fam, color: reqColor, size: sz, width: wd, reason: "no_variant_inventory" };
  }
  return { result: AVAILABILITY_RESULT.UNAVAILABLE, product, family: fam, color: reqColor, size: sz, width: wd, reason: "variant_not_carried" };
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
  const combo = comboPhrase(verdict);
  switch (verdict.result) {
    case AVAILABILITY_RESULT.AVAILABLE:
      return `Yes — the ${name} is available${combo ? ` in ${combo}` : ""}.`;
    case AVAILABILITY_RESULT.UNAVAILABLE:
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
