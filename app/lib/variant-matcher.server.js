// Variant-aware matcher (Phase B continuation).
//
// catalog-matcher.server.js handles PRODUCT-level scope (gender,
// category, color). This module owns VARIANT-level truth (size,
// width, SKU, inventoryQty) so the resolver, search filters,
// product-details handler, and fit-predictor all canonicalize the
// same way.
//
// Why this module exists: without it, the search filter's size
// normalization, getProductDetails's availableSizes computation,
// and the fit-predictor's size assertion each do their own
// canonicalization. That divergence is the root cause of the
// "card says 9.5 available, AI text says we don't have 9.5"
// class of bug.
//
// Public API:
//   canonicalizeVariantConstraints({size, width, sku}) -> {size, width, sku}
//   variantSatisfiesScope(variant, scope) -> boolean
//   findVariantSatisfying(product, scope) -> { found, reason? }
//   inStockSizes(product, {width?}) -> [normalizedSize, ...]
//   inStockWidths(product, {size?}) -> [normalizedWidth, ...]
//   variantInventoryStatus(variant) -> "in_stock" | "out_of_stock" | "untracked"
//
// All functions are pure — no DB calls — so the eval suite can
// pass fixture products directly.

// Normalize an option bag to a flat { name: value } object. Accepts Shopify's
// selectedOptions ARRAY ([{name:"Size",value:"8"}, …] — the REAL synced shape,
// written as `optionsJson: JSON.stringify(v.selectedOptions)`), a plain object
// ({ Size:"8" }), or a JSON string of either. Before this, readBagCI looped an
// array and produced "0"/"1" keys, so readVariantOption(v,"Size") returned
// undefined for every real synced variant — the root of "size 8 → UNKNOWN".
export function normalizeOptionBag(raw) {
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

// Read the variant's options bag case-insensitively under the
// keys merchants actually use in Shopify.
function readVariantOption(variant, key) {
  const fromOptions = readBagCI(normalizeOptionBag(variant?.optionsJson), key);
  if (fromOptions != null && fromOptions !== "") return fromOptions;
  return readBagCI(normalizeOptionBag(variant?.attributesJson), key);
}

// Normalize a size string. Strips a trailing W/N/M width letter
// when present so size + width remain independent constraints.
//
//   "9"          -> "9"
//   "9.5"        -> "9.5"
//   "9 ½"        -> "9.5"  (collapses unicode half)
//   "11W"        -> "11"   (width handled separately)
//   "Size 10"    -> "10"
//   "10.5 wide"  -> "10.5"
//   ""           -> null
export function normalizeVariantSize(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^size\s+/i, "");
  // Unicode half + fraction-y forms.
  s = s.replace(/\s*½/g, ".5").replace(/\s+1\/2/g, ".5");
  // Strip combined width suffix "11W" / "10.5n".
  const m = s.match(/^(\d{1,2}(?:\.\d)?)\s*[wnm](?:\b|$)/i);
  if (m) return m[1];
  // Strip trailing "wide" / "narrow" / "medium" tail.
  s = s.replace(/\s*(wide|narrow|medium|regular|standard)\s*$/i, "").trim();
  // Pure numeric → keep.
  if (/^\d{1,2}(?:\.\d)?$/.test(s)) return s;
  // Non-numeric size (rare — e.g. "S/M") → preserve as-is, lowercased.
  return s || null;
}

// Normalize a width signal to {wide, narrow, medium}.
//   "W" / "Wide" / "Extra Wide" / "XW" -> "wide"
//   "N" / "Narrow" / "Slim"            -> "narrow"
//   "M" / "Medium" / "Regular" / "B"   -> "medium"  (B is women's standard)
//   "11W" combined                     -> "wide"
//   anything else                       -> null
export function normalizeVariantWidth(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim();
  if (!s) return null;
  // Combined "11W" style — peel the trailing letter.
  const combo = s.match(/^\d{1,2}(?:\.\d)?\s*([wnm])\b/i);
  if (combo) {
    const w = combo[1].toLowerCase();
    return w === "w" ? "wide" : w === "n" ? "narrow" : "medium";
  }
  if (/\b(extra[-\s]?wide|xw|wide|w)\b/.test(s) && !/medium/.test(s)) return "wide";
  if (/\b(narrow|slim|n)\b/.test(s)) return "narrow";
  if (/\b(medium|regular|standard|m|b)\b/.test(s)) return "medium";
  return null;
}

export function canonicalizeVariantConstraints(input = {}) {
  const size = normalizeVariantSize(input.Size ?? input.size ?? input.SIZE);
  const width = normalizeVariantWidth(input.Width ?? input.width ?? input.WIDTH ?? input.Fit ?? input.fit);
  const skuRaw = input.SKU ?? input.sku ?? input.Sku;
  const sku = skuRaw == null ? null : String(skuRaw).trim().toLowerCase();
  return { size: size || null, width: width || null, sku: sku || null };
}

// Availability semantics preserved from chat-tools.server.js:
//   inventoryQty > 0  → in_stock
//   inventoryQty == 0 → out_of_stock
//   inventoryQty == null (untracked) → untracked (treated as available)
export function variantInventoryStatus(variant) {
  const q = variant?.inventoryQty;
  if (q == null) return "untracked";
  return Number(q) > 0 ? "in_stock" : "out_of_stock";
}

function variantIsAvailable(variant) {
  return variantInventoryStatus(variant) !== "out_of_stock";
}

export function variantSatisfiesScope(variant, scope = {}) {
  if (!variant) return false;
  const canonical = canonicalizeVariantConstraints(scope);

  if (canonical.sku) {
    const vSku = String(variant.sku || "").trim().toLowerCase();
    if (vSku !== canonical.sku) return false;
  }
  if (canonical.size) {
    const vSize = normalizeVariantSize(readVariantOption(variant, "Size"));
    if (vSize !== canonical.size) return false;
  }
  if (canonical.width) {
    const vWidth = normalizeVariantWidth(readVariantOption(variant, "Width")) ||
                   normalizeVariantWidth(readVariantOption(variant, "Fit"));
    // If the variant has no width signal at all, fall through to the
    // size match (many catalogs only set Width on wide/narrow variants).
    if (vWidth != null && vWidth !== canonical.width) return false;
  }
  // Inventory: must be available unless scope explicitly opts into OOS.
  if (!scope.includeOos && !variantIsAvailable(variant)) return false;
  return true;
}

export function findVariantSatisfying(product, scope = {}) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  for (const v of variants) {
    if (variantSatisfiesScope(v, scope)) return { found: v, reason: null };
  }
  // Why did it miss? Inform the caller so the response contract can
  // pick the right phrasing.
  const canonical = canonicalizeVariantConstraints(scope);
  // (a) Right size+width exists but is OOS → "back in stock alert" path.
  for (const v of variants) {
    const ok =
      (!canonical.size || normalizeVariantSize(readVariantOption(v, "Size")) === canonical.size) &&
      (!canonical.width || (() => {
        const w = normalizeVariantWidth(readVariantOption(v, "Width")) ||
                  normalizeVariantWidth(readVariantOption(v, "Fit"));
        return w == null || w === canonical.width;
      })());
    if (ok && !variantIsAvailable(v)) return { found: null, reason: "out_of_stock" };
  }
  // (b) Size or width simply not carried on this product.
  if (canonical.size || canonical.width) return { found: null, reason: "missing_variant" };
  // (c) Nothing in stock at all.
  return { found: null, reason: "no_in_stock_variants" };
}

// All distinct in-stock sizes on a product, optionally filtered by
// a requested width. Used by getProductDetails to ground size
// claims in actual variant data.
export function inStockSizes(product, { width = null } = {}) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const wantedWidth = normalizeVariantWidth(width);
  const out = new Set();
  for (const v of variants) {
    if (!variantIsAvailable(v)) continue;
    if (wantedWidth) {
      const vWidth = normalizeVariantWidth(readVariantOption(v, "Width")) ||
                     normalizeVariantWidth(readVariantOption(v, "Fit"));
      if (vWidth && vWidth !== wantedWidth) continue;
    }
    const s = normalizeVariantSize(readVariantOption(v, "Size"));
    if (s) out.add(s);
  }
  return Array.from(out).sort((a, b) => parseFloat(a) - parseFloat(b));
}

export function inStockWidths(product, { size = null } = {}) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const wantedSize = normalizeVariantSize(size);
  const out = new Set();
  for (const v of variants) {
    if (!variantIsAvailable(v)) continue;
    if (wantedSize) {
      const vSize = normalizeVariantSize(readVariantOption(v, "Size"));
      if (vSize !== wantedSize) continue;
    }
    const w = normalizeVariantWidth(readVariantOption(v, "Width")) ||
              normalizeVariantWidth(readVariantOption(v, "Fit"));
    if (w) out.add(w);
  }
  return Array.from(out);
}

// Truth check the LLM's claim about a size against actual variant
// inventory. Used by post-processing + fit-predictor to refuse a
// "size 9.5 is available" claim that doesn't match the catalog.
export function isSizeAvailable(product, size, { width = null } = {}) {
  const canonicalSize = normalizeVariantSize(size);
  if (!canonicalSize) return false;
  const sizes = inStockSizes(product, { width });
  return sizes.includes(canonicalSize);
}
