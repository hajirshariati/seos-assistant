// Foot conditions a product is tagged for, from the merchant's own tags and
// helps_with field. Used by the Catalog page's coverage report. Pure.

// Maps the merchant's free-text condition tag (case-insensitive) to a
// canonical conditionTag value the resolver / claim verifier uses.
const MERCHANT_CONDITION_TAG_MAP = {
  "bunions": "bunions",
  "plantar fasciitis": "plantar_fasciitis",
  "flat feet": "flat_feet",
  "high arch": "high_arch",
  "metatarsalgia": "metatarsalgia",
  "ball of foot pain": "metatarsalgia",
  "ball-of-foot pain": "metatarsalgia",
  "morton's neuroma": "mortons_neuroma",
  "mortons neuroma": "mortons_neuroma",
  "diabetic": "diabetic",
  "arthritis": "arthritis",
  "heel spur": "heel_spur",
  "heel spurs": "heel_spur",
  "heel pain": "heel_pain",
  "arch pain": "arch_pain",
  "hammer toes": "hammer_toes",
  "high instep": "high_instep",
  // Foot-width markers from the merchant's helps_with metafield.
  // Previously dropped on the floor — the map didn't include them,
  // so "Narrow Feet" / "Wide Feet" tags from details_icons never
  // reached the verifier. Live trace 2026-06-03 19:51:34: the Miles
  // sneaker is tagged "Narrow Feet" on Aetrex, yet appeared in a
  // "Do you have wide width?" result because the engine had no
  // signal that Miles is purpose-built for narrow feet.
  "narrow feet": "narrow_feet",
  "wide feet": "wide_feet",
};

// Read structured per-product condition signals from BOTH the
// merchant's `tags` array AND the `helps_with` attribute (which is
// the merchant's mapping of the `details_icons` metafield — a
// metaobject reference list curated by the merchant). Either source
// alone is sufficient; many shops will only populate one. Same
// normalization map for both so downstream consumers get a single
// canonical tag set.
export function extractMerchantConditionTags(product) {
  const out = new Set();

  // Source A: merchant tags array (e.g. "Bunions", "Plantar Fasciitis")
  const tags = Array.isArray(product?.tags) ? product.tags : [];
  for (const raw of tags) {
    const key = String(raw || "").toLowerCase().trim();
    if (MERCHANT_CONDITION_TAG_MAP[key]) out.add(MERCHANT_CONDITION_TAG_MAP[key]);
  }

  // Source B: helps_with attribute (merchant-mapped from
  // product.details_icons metafield). Value is a string or array of
  // strings, possibly JSON-encoded depending on metafield resolver.
  const attrs = (() => {
    try {
      const j = product?.attributesJson;
      if (!j) return null;
      return typeof j === "string" ? JSON.parse(j) : j;
    } catch { return null; }
  })();
  if (attrs && attrs.helps_with != null) {
    let helps = attrs.helps_with;
    if (typeof helps === "string") {
      const trimmed = helps.trim();
      if (trimmed.startsWith("[")) {
        try { helps = JSON.parse(trimmed); } catch { helps = [trimmed]; }
      } else {
        helps = [trimmed];
      }
    }
    if (!Array.isArray(helps)) helps = [String(helps)];
    for (const raw of helps) {
      const key = String(raw || "").toLowerCase().trim();
      if (MERCHANT_CONDITION_TAG_MAP[key]) out.add(MERCHANT_CONDITION_TAG_MAP[key]);
    }
  }

  return Array.from(out);
}
