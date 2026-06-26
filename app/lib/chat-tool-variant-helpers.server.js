import {
  findVariantSatisfying,
  normalizeVariantSize,
  normalizeVariantWidth,
  variantInventoryStatus,
  variantSatisfiesScope,
  normalizeOptionBag,
} from "./variant-matcher.server.js";

export function productIsVisibleToChat(product) {
  const status = String(product?.status || "").trim().toLowerCase();
  return status !== "draft" && status !== "archived";
}

export function hasVariantScope(scope = {}) {
  return Boolean(scope?.size || scope?.width || scope?.sku);
}

export function availableVariantsForScope(product, scope = {}) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (hasVariantScope(scope)) {
    return variants.filter((variant) => variantSatisfiesScope(variant, scope));
  }
  const scoped = variants.filter((variant) => variantInventoryStatus(variant) !== "out_of_stock");
  return scoped.length > 0 ? scoped : variants;
}

export function productMatchesVariantScope(product, scope = {}) {
  if (!hasVariantScope(scope)) return true;
  return Boolean(findVariantSatisfying(product, scope).found);
}

export function variantScopedPriceValues(product, scope = {}) {
  const variants = availableVariantsForScope(product, scope);
  return variants
    .map((v) => (v.price != null ? Number(v.price) : null))
    .filter((n) => Number.isFinite(n));
}

function readVariantBagValue(variant, aliases) {
  // normalizeOptionBag handles Shopify's selectedOptions array shape, plain
  // objects, and JSON strings of either (optionsJson is a stringified array).
  const bags = [normalizeOptionBag(variant?.optionsJson), normalizeOptionBag(variant?.attributesJson)];
  const wanted = aliases.map((a) => String(a).toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  for (const bag of bags) {
    if (!bag || typeof bag !== "object") continue;
    for (const [key, value] of Object.entries(bag)) {
      const norm = String(key).toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (wanted.includes(norm)) return value;
    }
  }
  return undefined;
}

export function normalizedVariantSize(variant) {
  return normalizeVariantSize(readVariantBagValue(variant, ["Size", "size"]));
}

export function normalizedVariantWidth(variant) {
  return normalizeVariantWidth(readVariantBagValue(variant, ["Width", "width", "Fit", "fit"]));
}
