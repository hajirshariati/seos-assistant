// Catalog facts builder (Milestone 1).
//
// Reads from existing Product / ProductVariant rows (which are
// already synced from Shopify by app/models/Product.server.js) and
// derives normalized CatalogFact rows plus a per-shop
// CatalogFacetIndex. NEVER calls Shopify directly — that's the
// existing sync path's job.
//
// Availability rule (preserves existing chat-tools semantics):
//   - any variant with inventoryQty > 0           → available
//   - any variant with inventoryQty == null       → available (untracked)
//   - all variants tracked AND <= 0               → out of stock
//
// Called from:
//   - app/models/Product.server.js after upsertProduct (single rebuild)
//   - app/models/Product.server.js after syncCatalog (full rebuild)
//   - app/routes/webhooks.products.delete.jsx (delete row, recompute index)

import prisma from "../db.server.js";

// ─── normalization helpers ─────────────────────────────────────

const COLOR_SYNONYMS = {
  burgundy: "burgundy", wine: "burgundy", maroon: "burgundy",
  navy: "navy", "navy blue": "navy",
  cognac: "cognac", tan: "tan", camel: "tan",
  charcoal: "charcoal", gray: "gray", grey: "gray",
  white: "white", "off white": "white", ivory: "white", cream: "white",
  black: "black",
  brown: "brown", chocolate: "brown", walnut: "brown", chestnut: "brown",
  red: "red",
  pink: "pink", rose: "pink", coral: "pink",
  blue: "blue", denim: "blue",
  green: "green", olive: "green", sage: "green",
  yellow: "yellow", mustard: "yellow", honey: "yellow",
  orange: "orange",
  purple: "purple", violet: "purple",
  gold: "gold", silver: "silver", bronze: "bronze", taupe: "taupe",
};

function normalizeColor(raw) {
  if (!raw) return null;
  const lc = String(raw).toLowerCase().trim().replace(/[_-]+/g, " ");
  if (COLOR_SYNONYMS[lc]) return COLOR_SYNONYMS[lc];
  // Multi-word phrase match — try longest keys first so "off white"
  // wins over "white" when both appear.
  const keys = Object.keys(COLOR_SYNONYMS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    // Word-boundary match. Avoids "blackberry" → "black" and
    // "whiteboard" → "white". Multi-word keys ("off white") use
    // \s+ between tokens.
    const pattern = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const re = new RegExp(`\\b${pattern}\\b`, "i");
    if (re.test(lc)) return COLOR_SYNONYMS[key];
  }
  return null;
}

const CATEGORY_SYNONYMS = {
  sneakers: "sneakers", sneaker: "sneakers", trainers: "sneakers", trainer: "sneakers",
  // Aetrex / footwear-merchant productTypes that ARE sneakers.
  "walking shoes": "sneakers", "walking shoe": "sneakers",
  "running shoes": "sneakers", "running shoe": "sneakers",
  "athletic shoes": "sneakers", "athletic shoe": "sneakers",
  "training shoes": "sneakers", "training shoe": "sneakers",
  "casual shoes": "sneakers", "casual shoe": "sneakers", "casual sneaker": "sneakers", "casual sneakers": "sneakers",
  "tennis shoes": "sneakers", "tennis shoe": "sneakers",
  "gym shoes": "sneakers", "gym shoe": "sneakers",
  sandals: "sandals", sandal: "sandals", slides: "sandals",
  flips: "sandals", "flip flops": "sandals", "flip-flops": "sandals",
  boots: "boots", boot: "boots", booties: "boots", "ankle boots": "boots",
  "winter boots": "boots", "snow boots": "boots", "work boots": "boots",
  loafers: "loafers", loafer: "loafers",
  oxfords: "oxfords", oxford: "oxfords", "dress shoes": "oxfords", "dress shoe": "oxfords",
  clogs: "clogs", clog: "clogs", "slip-on": "slip-ons", "slip ons": "slip-ons",
  "slip ons": "slip-ons", "slip-ons": "slip-ons",
  slippers: "slippers", slipper: "slippers",
  "mary janes": "mary-janes", "mary-janes": "mary-janes",
  "wedges heels": "wedges-heels", wedges: "wedges-heels", heels: "wedges-heels", pumps: "wedges-heels",
  orthotics: "orthotics", orthotic: "orthotics", insoles: "orthotics", insole: "orthotics", insert: "orthotics", inserts: "orthotics", footbed: "orthotics", footbeds: "orthotics",
  accessories: "accessories", accessory: "accessories",
  footwear: "footwear",
};

function normalizeCategory(raw) {
  if (!raw) return null;
  const lc = String(raw).toLowerCase().trim();
  return CATEGORY_SYNONYMS[lc] || null;
}

const GENDER_SYNONYMS = {
  men: "men", mens: "men", "men's": "men", male: "men", man: "men",
  women: "women", womens: "women", "women's": "women", female: "women", woman: "women", ladies: "women",
  kids: "kids", kid: "kids", child: "kids", children: "kids", youth: "kids",
  unisex: "unisex",
};

function normalizeGender(raw) {
  if (!raw) return null;
  const lc = String(raw).toLowerCase().trim();
  return GENDER_SYNONYMS[lc] || null;
}

// Condition tags derived from product tags + description heuristics.
const CONDITION_KEYWORDS = {
  plantar_fasciitis: /\bplantar(?:\s+fasciitis)?\b/i,
  flat_feet: /\b(?:flat\s+feet|low\s+arch|fallen\s+arches?|overpronation)\b/i,
  high_arch: /\b(?:high\s+arch|underpronation|supination)\b/i,
  bunions: /\bbunion(?:s|ettes?)?\b/i,
  metatarsalgia: /\b(?:metatarsalgia|ball[- ]of[- ]foot|forefoot\s+pain)\b/i,
  mortons_neuroma: /\bmorton'?s?\s+neuroma\b/i,
  diabetic: /\b(?:diabetic|diabetes|neuropathy)\b/i,
  arthritis: /\barthritis\b/i,
  heel_spur: /\bheel\s+spur(?:s)?\b/i,
};

const USE_CASE_KEYWORDS = {
  walking: /\b(?:walking|stroll|long\s+walks?)\b/i,
  running: /\b(?:running|jogging|marathon)\b/i,
  travel: /\b(?:travel|trip|vacation|tourism|sightseeing|cruise)\b/i,
  dress: /\b(?:dress|formal|wedding|gala|business|office)\b/i,
  casual: /\b(?:casual|everyday|weekend)\b/i,
  athletic: /\b(?:athletic|gym|workout|training)\b/i,
  winter: /\b(?:winter|cold[- ]weather|snow)\b/i,
  hiking: /\b(?:hiking|trail|outdoor)\b/i,
  standing_all_day: /\b(?:standing\s+all\s+day|on\s+(?:my|your)\s+feet)\b/i,
  beach: /\b(?:beach|pool|water)\b/i,
};

const WIDTH_KEYWORDS = {
  wide: /\b(?:wide(?:[- ]width)?|w\b|extra[- ]wide|xw)\b/i,
  narrow: /\b(?:narrow|n\b|slim)\b/i,
  medium: /\b(?:medium(?:[- ]width)?|m\b|regular(?:[- ]width)?)\b/i,
};

function extractTagsByKeywords(text, mapping) {
  if (!text) return [];
  const lc = String(text).toLowerCase();
  const out = new Set();
  for (const [tag, re] of Object.entries(mapping)) {
    if (re.test(lc)) out.add(tag);
  }
  return Array.from(out);
}

// Extract a "search corpus" from a product — title + description +
// tags + productType — so heuristic taggers can scan everything.
function buildCorpus(product) {
  const parts = [
    product.title || "",
    product.description || "",
    product.productType || "",
    Array.isArray(product.tags) ? product.tags.join(" ") : "",
    typeof product.attributesJson === "object" && product.attributesJson
      ? JSON.stringify(product.attributesJson)
      : "",
  ];
  return parts.join("  ");
}

// Case-insensitive lookup on an attribute bag. Merchants store
// Shopify metafields with arbitrary key capitalization ("Color" /
// "color" / "COLOR" / "Colour"), so a case-sensitive lookup misses
// real values. Returns the first non-empty value matching any of
// the requested aliases.
function readAttr(bag, aliases) {
  if (!bag || typeof bag !== "object") return null;
  const keys = Object.keys(bag);
  const lookup = new Map();
  for (const k of keys) lookup.set(k.toLowerCase(), bag[k]);
  for (const alias of aliases) {
    const v = lookup.get(alias.toLowerCase());
    if (v != null && v !== "") return v;
  }
  return null;
}

function safeParseAttrs(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Pull gender from (1) attributesJson["Gender"] direct, (2) variant
// attributesJson["Gender"] direct, then (3) corpus scan as fallback.
// Returns an array since a product can be tagged for multiple
// (e.g. unisex).
function extractGender(product) {
  const out = new Set();
  // 1. Product-level attribute
  const direct = readAttr(safeParseAttrs(product.attributesJson), ["gender"]);
  if (direct) {
    const arr = Array.isArray(direct) ? direct : [direct];
    for (const v of arr) {
      const norm = normalizeGender(v);
      if (norm) out.add(norm);
    }
  }
  // 2. Variant-level attribute
  for (const v of product.variants || []) {
    const a = readAttr(safeParseAttrs(v.attributesJson), ["gender"]);
    if (a) {
      const arr = Array.isArray(a) ? a : [a];
      for (const item of arr) {
        const norm = normalizeGender(item);
        if (norm) out.add(norm);
      }
    }
  }
  // 3. Corpus fallback (tags / title / description)
  const corpus = buildCorpus(product).toLowerCase();
  for (const [synonym, canonical] of Object.entries(GENDER_SYNONYMS)) {
    // Word-boundary check to avoid matching e.g. "amen" → "men"
    const re = new RegExp(`(?:^|[^a-z])${synonym.replace(/'/g, "['']?")}(?:[^a-z]|$)`, "i");
    if (re.test(corpus)) out.add(canonical);
  }
  return Array.from(out);
}

function extractCategory(product) {
  // 1. attributesJson Category
  const directAttr = readAttr(safeParseAttrs(product.attributesJson), ["category", "product_type", "productType"]);
  const normDirect = normalizeCategory(directAttr);
  if (normDirect) return normDirect;
  // 2. productType is the strongest signal in Aetrex's catalog.
  const pt = normalizeCategory(product.productType);
  if (pt) return pt;
  // 3. Fall back to scanning tags + title. Try LONGEST synonyms
  //    first so "walking shoes" wins over "shoes" when both match.
  const corpus = buildCorpus(product).toLowerCase();
  const keys = Object.keys(CATEGORY_SYNONYMS).sort((a, b) => b.length - a.length);
  for (const synonym of keys) {
    const re = new RegExp(`\\b${synonym.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(corpus)) return CATEGORY_SYNONYMS[synonym];
  }
  return null;
}

function extractColors(product) {
  const out = new Set();
  // 1. Tags often carry color words.
  for (const t of product.tags || []) {
    const c = normalizeColor(t);
    if (c) out.add(c);
  }
  // 2. attributesJson Color (case-insensitive).
  const directAttr = readAttr(safeParseAttrs(product.attributesJson), ["color", "colour", "color_family", "colorfamily"]);
  if (directAttr) {
    const arr = Array.isArray(directAttr) ? directAttr : [directAttr];
    for (const v of arr) {
      const c = normalizeColor(v);
      if (c) out.add(c);
    }
  }
  // 3. Title patterns (more flexible than the legacy suffix-only):
  //    "Vania Sandal - Red"           (hyphen suffix)
  //    "Aetrex Daphne White"           (trailing word, no hyphen)
  //    "White Daphne Sneaker"          (leading word)
  //    "Daphne in White"               ("in <color>" phrase)
  //    "Daphne | White"                (pipe separator)
  const title = String(product.title || "");
  // Stage A: scan every whitespace-separated token of the title for a
  // direct color match.
  for (const tok of title.split(/\s+/)) {
    const c = normalizeColor(tok);
    if (c) out.add(c);
  }
  // Stage B: phrase patterns
  const phraseMatches = [
    /\s[-–—|]\s+([\w-]+(?:\s+[\w-]+)?)$/i,    // suffix " - Color" / " | Color"
    /\bin\s+([a-z][a-z\s-]+?)$/i,              // "Daphne in Off-White"
  ];
  for (const re of phraseMatches) {
    const m = title.match(re);
    if (m) {
      const c = normalizeColor(m[1]);
      if (c) out.add(c);
    }
  }
  // 4. Variant option JSON (legacy Shopify product-options shape).
  for (const v of product.variants || []) {
    const opts = safeParseAttrs(v.optionsJson);
    if (opts) {
      const direct = readAttr(opts, ["color", "colour"]);
      if (direct != null) {
        const c = normalizeColor(direct);
        if (c) out.add(c);
      }
    }
    // 5. Variant attributesJson (case-insensitive).
    const va = readAttr(safeParseAttrs(v.attributesJson), ["color", "colour", "color_family"]);
    if (va) {
      const arr = Array.isArray(va) ? va : [va];
      for (const item of arr) {
        const c = normalizeColor(item);
        if (c) out.add(c);
      }
    }
  }
  return Array.from(out);
}

function extractSizes(product) {
  const out = new Set();
  for (const v of product.variants || []) {
    let opts = null;
    try {
      opts = typeof v.optionsJson === "string" ? JSON.parse(v.optionsJson) : v.optionsJson;
    } catch { /* skip */ }
    if (opts && typeof opts === "object") {
      for (const key of ["Size", "size", "SIZE"]) {
        if (opts[key]) out.add(String(opts[key]));
      }
    }
  }
  return Array.from(out);
}

function extractWidths(product) {
  const out = new Set();
  const corpus = buildCorpus(product);
  for (const t of extractTagsByKeywords(corpus, WIDTH_KEYWORDS)) out.add(t);
  // Also check variant options.
  for (const v of product.variants || []) {
    let opts = null;
    try {
      opts = typeof v.optionsJson === "string" ? JSON.parse(v.optionsJson) : v.optionsJson;
    } catch { /* skip */ }
    if (opts && typeof opts === "object") {
      for (const key of ["Width", "width", "Fit", "fit"]) {
        if (opts[key]) {
          const lc = String(opts[key]).toLowerCase();
          if (/\bw\b|wide/.test(lc)) out.add("wide");
          if (/\bn\b|narrow/.test(lc)) out.add("narrow");
          if (/\bm\b|medium|regular/.test(lc)) out.add("medium");
        }
      }
    }
  }
  return Array.from(out);
}

// Availability rule preserved from chat-tools.server.js:
// any variant with inventoryQty > 0 OR null (untracked) → available
function computeAvailability(product) {
  const vs = product.variants || [];
  if (vs.length === 0) return { available: true, totalInventory: 0, inventoryUntracked: true };
  let totalInventory = 0;
  let anyUntracked = false;
  let anyInStock = false;
  for (const v of vs) {
    const q = v.inventoryQty;
    if (q == null) {
      anyUntracked = true;
      anyInStock = true; // untracked counts as available
    } else if (Number(q) > 0) {
      anyInStock = true;
      totalInventory += Number(q);
    }
  }
  return {
    available: anyInStock,
    totalInventory,
    inventoryUntracked: anyUntracked,
  };
}

function computePriceRange(product) {
  const prices = (product.variants || [])
    .map((v) => (v.price != null ? Number(v.price) : null))
    .filter((n) => Number.isFinite(n));
  if (prices.length === 0) return { priceMin: null, priceMax: null };
  return { priceMin: Math.min(...prices), priceMax: Math.max(...prices) };
}

// ─── public API ────────────────────────────────────────────────

// Rebuild facts for a single product. Called from upsertProduct.
// Idempotent: safe to call repeatedly.
export async function rebuildCatalogFactsForProduct(shop, productId) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { variants: true },
  });
  if (!product) {
    // Product was deleted; remove its facts.
    await prisma.catalogFact.deleteMany({
      where: { shop, productId },
    });
    return null;
  }

  const corpus = buildCorpus(product);
  const category = extractCategory(product);
  const gender = extractGender(product);
  const colors = extractColors(product);
  const sizes = extractSizes(product);
  const widths = extractWidths(product);
  const conditionTags = extractTagsByKeywords(corpus, CONDITION_KEYWORDS);
  const useCaseTags = extractTagsByKeywords(corpus, USE_CASE_KEYWORDS);
  const availability = computeAvailability(product);
  const priceRange = computePriceRange(product);

  const factKey = `product:${product.id}`;
  const data = {
    shop,
    factKey,
    productHandle: product.handle,
    productId: product.id,
    variantId: null,
    variantSku: null,
    title: product.title,
    category,
    productType: product.productType || null,
    gender,
    colors,
    sizes,
    widths,
    conditionTags,
    useCaseTags,
    fitTags: [],
    available: availability.available,
    totalInventory: availability.totalInventory,
    inventoryUntracked: availability.inventoryUntracked,
    priceMin: priceRange.priceMin,
    priceMax: priceRange.priceMax,
    sourceUpdatedAt: product.updatedAt,
  };

  await prisma.catalogFact.upsert({
    where: { shop_factKey: { shop, factKey } },
    update: data,
    create: data,
  });

  return data;
}

// Remove facts for a deleted product.
export async function deleteCatalogFactsForProduct(shop, productId) {
  await prisma.catalogFact.deleteMany({
    where: { shop, productId },
  });
}

// Full rebuild: drop all facts for shop, recompute everything,
// then rebuild the facet index. Per correction #4, this is cheap
// enough at 689 products that we don't need incremental.
export async function rebuildAllCatalogFacts(shop) {
  const products = await prisma.product.findMany({
    where: { shop, NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } } },
    include: { variants: true },
  });

  // Delete existing facts for shop.
  await prisma.catalogFact.deleteMany({ where: { shop } });

  // Rebuild row-by-row.
  for (const p of products) {
    try {
      await rebuildCatalogFactsForProduct(shop, p.id);
    } catch (err) {
      console.error(`[catalog-facts] failed for product ${p.id}: ${err?.message || err}`);
    }
  }

  await rebuildCatalogFacetIndex(shop);

  return { products: products.length };
}

// Rebuild the per-shop facet index from current CatalogFact rows.
// Cheap (one query, in-memory aggregation) so we recompute fully
// after every facts change.
export async function rebuildCatalogFacetIndex(shop) {
  const facts = await prisma.catalogFact.findMany({
    where: { shop, available: true },
    select: {
      category: true,
      gender: true,
      colors: true,
      sizes: true,
      conditionTags: true,
    },
  });

  const categoryByGender = {};         // category -> Set(gender)
  const colorByGenderCategory = {};    // "gender:category" -> Set(color)
  const conditionByCategory = {};      // category -> Set(condition)
  const sizeByGenderCategory = {};     // "gender:category" -> Set(size)

  for (const f of facts) {
    const cat = f.category;
    if (!cat) continue;
    const genders = f.gender && f.gender.length > 0 ? f.gender : ["unisex"];

    for (const g of genders) {
      if (!categoryByGender[cat]) categoryByGender[cat] = new Set();
      categoryByGender[cat].add(g);

      const gck = `${g}:${cat}`;

      if (f.colors && f.colors.length > 0) {
        if (!colorByGenderCategory[gck]) colorByGenderCategory[gck] = new Set();
        for (const c of f.colors) colorByGenderCategory[gck].add(c);
      }

      if (f.sizes && f.sizes.length > 0) {
        if (!sizeByGenderCategory[gck]) sizeByGenderCategory[gck] = new Set();
        for (const s of f.sizes) sizeByGenderCategory[gck].add(s);
      }
    }

    if (f.conditionTags && f.conditionTags.length > 0) {
      if (!conditionByCategory[cat]) conditionByCategory[cat] = new Set();
      for (const c of f.conditionTags) conditionByCategory[cat].add(c);
    }
  }

  // Materialize Sets → arrays for JSON storage.
  const mat = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = Array.from(v).sort();
    return out;
  };

  const totalFacts = await prisma.catalogFact.count({ where: { shop } });
  const availableFacts = facts.length;

  await prisma.catalogFacetIndex.upsert({
    where: { shop },
    update: {
      categoryByGender: mat(categoryByGender),
      colorByGenderCategory: mat(colorByGenderCategory),
      conditionByCategory: mat(conditionByCategory),
      sizeByGenderCategory: mat(sizeByGenderCategory),
      totalProducts: totalFacts,
      availableProducts: availableFacts,
    },
    create: {
      shop,
      categoryByGender: mat(categoryByGender),
      colorByGenderCategory: mat(colorByGenderCategory),
      conditionByCategory: mat(conditionByCategory),
      sizeByGenderCategory: mat(sizeByGenderCategory),
      totalProducts: totalFacts,
      availableProducts: availableFacts,
    },
  });

  return {
    totalProducts: totalFacts,
    availableProducts: availableFacts,
  };
}

// Read the facet index. Returns null if no index has been built yet.
export async function getCatalogFacetIndex(shop) {
  return prisma.catalogFacetIndex.findUnique({ where: { shop } });
}

// Internal export for testing — surfaces the normalization helpers
// so the eval suite can use them on fixture data.
export const __internals = {
  normalizeColor,
  normalizeCategory,
  normalizeGender,
  extractColors,
  extractGender,
  extractCategory,
  extractTagsByKeywords,
  CONDITION_KEYWORDS,
  USE_CASE_KEYWORDS,
  computeAvailability,
};
