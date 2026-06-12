import {
  normalizeCategory,
  normalizeColor,
  normalizeGender,
} from "./catalog-facts.server.js";

export function canonicalizeCatalogConstraints(input = {}) {
  const out = { ...input };
  const aliasValue = (primary, aliases) => {
    if (out[primary] != null && out[primary] !== "") return out[primary];
    for (const alias of aliases) {
      if (out[alias] != null && out[alias] !== "") {
        const v = out[alias];
        delete out[alias];
        return v;
      }
    }
    return out[primary];
  };

  out.gender = aliasValue("gender", ["Gender", "gender_fallback", "Gender_Fallback", "genders", "Genders"]);
  out.category = aliasValue("category", ["Category", "category_for_filter", "Category_For_Filter", "subcategory", "Subcategory", "product_type", "productType"]);
  out.color = aliasValue("color", ["Color", "colour", "Colour", "color_family", "Color Family", "colorFamily"]);

  if (out.gender) {
    out.gender = normalizeGender(out.gender) || String(out.gender).toLowerCase().trim();
  }
  if (out.category) {
    out.category = normalizeCategory(out.category) || String(out.category).toLowerCase().trim().replace(/\s+/g, "-");
  }
  if (out.color) {
    out.color = normalizeColor(out.color) || String(out.color).toLowerCase().trim();
  }
  return out;
}

export function buildCatalogTupleSpace(facetIndex) {
  const tuples = [];
  const cbgc = facetIndex?.colorByGenderCategory || {};
  for (const [gck, colors] of Object.entries(cbgc)) {
    const [gender, category] = gck.split(":");
    if (!gender || !category) continue;
    const colorList = Array.isArray(colors) && colors.length > 0 ? colors : [null];
    for (const color of colorList) {
      tuples.push({ gender, category, color });
    }
  }

  const cbg = facetIndex?.categoryByGender || {};
  for (const [category, genders] of Object.entries(cbg)) {
    if (!Array.isArray(genders)) continue;
    for (const gender of genders) {
      const has = tuples.some((t) => t.gender === gender && t.category === category);
      if (!has) tuples.push({ gender, category, color: null });
    }
  }

  return tuples;
}

function normalizeAllowedCategory(raw) {
  return normalizeCategory(raw) || String(raw || "").toLowerCase().trim().replace(/[_\s]+/g, "-");
}

function restrictCatalogTuples(tuples, allowedCategories = []) {
  const allowed = new Set(
    (Array.isArray(allowedCategories) ? allowedCategories : [])
      .map(normalizeAllowedCategory)
      .filter(Boolean),
  );
  if (allowed.size === 0) return tuples || [];
  return (tuples || []).filter((tuple) => allowed.has(normalizeAllowedCategory(tuple?.category)));
}

export function catalogTupleMatches(tuple, constraints = {}) {
  const canonical = canonicalizeCatalogConstraints(constraints);
  if (canonical.gender && tuple.gender) {
    // Adult unisex products can satisfy men's/women's browsing, but
    // "unisex" alone is not proof that a product is made for kids.
    // Kids must be explicit in the synced catalog facts.
    if (tuple.gender === "unisex" && canonical.gender === "kids") return false;
    if (tuple.gender !== "unisex" && tuple.gender !== canonical.gender) return false;
  }
  if (canonical.category && tuple.category && tuple.category !== canonical.category) {
    return false;
  }
  if (canonical.color != null) {
    // A missing color fact is not proof that a requested color exists.
    // This matters for navigation choices: a category/gender bucket with
    // no color data must never make "pink" look available.
    if (tuple.color == null || tuple.color !== canonical.color) return false;
  }
  return true;
}

export function projectCatalogField(tuples, constraints, field) {
  const out = new Set();
  for (const t of tuples || []) {
    if (!catalogTupleMatches(t, constraints)) continue;
    const v = t[field];
    if (v == null) continue;
    if (field === "gender" && v === "unisex") continue;
    out.add(v);
  }
  return Array.from(out);
}

export function computeCatalogConstraintDomains(known, facetIndex, { allowedCategories = [] } = {}) {
  const tuples = restrictCatalogTuples(buildCatalogTupleSpace(facetIndex), allowedCategories);
  const fields = ["gender", "category", "color"];
  const out = {};
  for (const field of fields) {
    if (known?.[field] != null) continue;
    const domain = projectCatalogField(tuples, known || {}, field);
    out[field] = { domain };
    if (domain.length === 1) out[field].inferred = domain[0];
  }
  return out;
}

export function catalogScopeHasMatches(facetIndex, constraints = {}, { allowedCategories = [] } = {}) {
  if (!facetIndex) return null;
  const tuples = restrictCatalogTuples(buildCatalogTupleSpace(facetIndex), allowedCategories);
  return tuples.some((tuple) => catalogTupleMatches(tuple, constraints));
}

// Per-field value domains of the facet tuple space — the catalog's
// actual vocabulary for gender/category/color. Used by the navigation
// verdict to decide whether a constraint value is even part of this
// catalog before letting it prove impossibility.
function catalogTupleFieldDomains(tuples) {
  const domains = { gender: new Set(), category: new Set(), color: new Set() };
  for (const t of tuples || []) {
    if (t?.gender) domains.gender.add(t.gender);
    if (t?.category) domains.category.add(t.category);
    if (t?.color != null) domains.color.add(t.color);
  }
  return domains;
}

function fieldValueInDomain(field, value, domains) {
  if (value == null || value === "") return true;
  const domain = domains?.[field];
  if (!domain) return true;
  if (domain.has(value)) return true;
  // Unisex tuples genuinely satisfy men's/women's constraints (see
  // catalogTupleMatches), so those values are provable in this catalog
  // even when no explicitly gendered tuple exists. "kids" stays out:
  // unisex is never proof of kids availability.
  if (field === "gender" && domain.has("unisex") && (value === "men" || value === "women")) {
    return true;
  }
  return false;
}

// Umbrella CATEGORY-GROUP vocabulary: each merchant group's name plus
// its triggers, lowercased, with light singular/plural variants
// ("footwear", "shoes" → "shoe"). Purely merchant-config-driven — no
// hardcoded store vocabulary. Threaded into
// catalogScopedNavigationQuestionVerdict so an umbrella group word
// parsed as a facet category ("travel shoes" → category "shoes") is
// dropped instead of proving a false catalog impossibility.
export function umbrellaCategoryTermsFromGroups(merchantGroups = []) {
  const out = new Set();
  const add = (raw) => {
    const term = String(raw || "").toLowerCase().trim();
    if (!term) return;
    out.add(term);
    if (term.endsWith("s")) out.add(term.replace(/s$/, ""));
    else out.add(`${term}s`);
  };
  for (const group of Array.isArray(merchantGroups) ? merchantGroups : []) {
    add(group?.name);
    for (const trigger of Array.isArray(group?.triggers) ? group.triggers : []) {
      add(trigger);
    }
  }
  return Array.from(out);
}

// Shared final boundary for quick-reply questions that navigate product
// facets. After an exact no-match, missing catalog proof must fail closed.
export function catalogScopedNavigationQuestionVerdict({
  question = "",
  choice = {},
  constraints = {},
  impossibleConstraints = [],
  facetIndex = null,
  allowedCategories = [],
  requireProof = false,
  umbrellaCategoryTerms = [],
} = {}) {
  // The catalog's per-field vocabulary, computed once from the FULL
  // tuple space. The active merchant-group restriction is applied
  // separately (allowedCategories → restrictCatalogTuples) inside
  // catalogScopeHasMatches; vocabulary membership must not depend on it.
  const domains = facetIndex
    ? catalogTupleFieldDomains(buildCatalogTupleSpace(facetIndex))
    : null;

  const parsed = canonicalizeCatalogConstraints(choice || {});
  const facetChoice = {};
  for (const field of ["gender", "category", "color"]) {
    if (parsed[field]) facetChoice[field] = parsed[field];
  }

  // The chip's own gender and color stay STRICT — a missing color fact
  // never makes "pink" look available (fail closed). For
  // facetChoice.category ONLY: when the value is an umbrella
  // CATEGORY-GROUP term (group name/trigger from merchant config) that
  // isn't a real tuple category, drop it instead of failing — the group
  // restriction is already enforced via allowedCategories, so the
  // umbrella word adds no information. 2026-06-12 trace: follow-up
  // "What's your budget for travel shoes?" parsed category "shoes";
  // no tuple carries category="shoes", so the suggestion was wrongly
  // dropped as catalog_intersection_empty.
  if (facetChoice.category && domains && !fieldValueInDomain("category", facetChoice.category, domains)) {
    const umbrella = new Set(
      (Array.isArray(umbrellaCategoryTerms) ? umbrellaCategoryTerms : [])
        .map((term) => String(term || "").toLowerCase().trim())
        .filter(Boolean),
    );
    if (umbrella.has(facetChoice.category)) delete facetChoice.category;
  }

  // Sanitize the BASE (carried-over) scope: a gender/category/color
  // value that doesn't exist in the tuple-space vocabulary cannot prove
  // impossibility — it's an umbrella group name or stale non-catalog
  // memory, not a facet. 2026-06-12 trace: memory carried
  // category="footwear" (the merchant's umbrella "Footwear" GROUP name;
  // tuples carry sandals/sneakers/boots/…), so EVERY gender chip
  // evaluated impossible and <<Men's>>/<<Women's>> were stripped. The
  // group restriction is already applied via allowedCategories, so
  // dropping the out-of-vocabulary value loses nothing.
  const base = canonicalizeCatalogConstraints(constraints || {});
  if (domains) {
    for (const field of ["gender", "category", "color"]) {
      if (base[field] && !fieldValueInDomain(field, base[field], domains)) {
        delete base[field];
      }
    }
  }
  const effectiveConstraints = canonicalizeCatalogConstraints({ ...base, ...facetChoice });
  if (Object.keys(facetChoice).length === 0) {
    return {
      possible: true,
      reason: "not_product_navigation",
      question,
      choice: facetChoice,
      effectiveConstraints,
    };
  }

  const repeatedImpossible = (Array.isArray(impossibleConstraints) ? impossibleConstraints : [])
    .map((constraint) => {
      const field = String(constraint?.field || "");
      if (!["gender", "category", "color"].includes(field)) return null;
      const canonical = canonicalizeCatalogConstraints({ [field]: constraint?.value });
      return canonical[field] && effectiveConstraints[field] === canonical[field]
        ? { field, value: canonical[field] }
        : null;
    })
    .find(Boolean);
  if (repeatedImpossible) {
    return {
      possible: false,
      reason: "repeats_resolver_impossible_constraint",
      question,
      choice: facetChoice,
      effectiveConstraints,
      impossibleConstraint: repeatedImpossible,
    };
  }

  const match = catalogScopeHasMatches(
    facetIndex,
    effectiveConstraints,
    { allowedCategories },
  );
  if (match === true) {
    return {
      possible: true,
      reason: "catalog_match",
      question,
      choice: facetChoice,
      effectiveConstraints,
    };
  }
  if (match === false) {
    return {
      possible: false,
      reason: "catalog_intersection_empty",
      question,
      choice: facetChoice,
      effectiveConstraints,
    };
  }
  return {
    possible: !requireProof,
    reason: requireProof ? "catalog_proof_required" : "catalog_proof_unavailable",
    question,
    choice: facetChoice,
    effectiveConstraints,
  };
}

export function catalogFieldOptions(facetIndex, constraints, field, { allowedCategories = [] } = {}) {
  if (!facetIndex) return [];
  const tuples = restrictCatalogTuples(buildCatalogTupleSpace(facetIndex), allowedCategories);
  return projectCatalogField(tuples, constraints || {}, field).sort();
}

export function colorExistsInCatalogScope(color, gender, category, facetIndex, { allowedCategories = [] } = {}) {
  const canonical = canonicalizeCatalogConstraints({ color, gender, category });
  if (!canonical.color || !facetIndex) return null;
  const tuples = restrictCatalogTuples(buildCatalogTupleSpace(facetIndex), allowedCategories);
  const scopeConstraints = {};
  if (canonical.gender) scopeConstraints.gender = canonical.gender;
  if (canonical.category) scopeConstraints.category = canonical.category;
  // Absence of color FACTS is not proof of color absence: a tuple only
  // carries a color when extraction found one, so a real product with
  // an untagged color contributes color:null. If the scope has zero
  // color data, return null (unproven) — the resolver must ask, not
  // assert "no <color> products" about a catalog it can't see colors
  // for (the unnamed-search half of the false-denial class).
  let sawColorFact = false;
  for (const t of tuples) {
    if (t.color == null) continue;
    if (!catalogTupleMatches(t, scopeConstraints)) continue;
    sawColorFact = true;
    if (t.color === canonical.color) return true;
  }
  return sawColorFact ? false : null;
}

export function readAttributeCI(bag, keyOrAliases) {
  if (!bag || typeof bag !== "object") return undefined;
  const aliases = Array.isArray(keyOrAliases) ? keyOrAliases : [keyOrAliases];
  const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const wanted = new Set(aliases.map((a) => normalizeKey(a)));
  for (const [key, value] of Object.entries(bag)) {
    if (wanted.has(normalizeKey(key))) return value;
  }

  if (wanted.has("color")) {
    for (const [key, value] of Object.entries(bag)) {
      const lc = normalizeKey(key);
      if (lc === "colour" || lc === "color_family" || lc === "colorfamily") return value;
    }
  }

  if (wanted.has("category")) {
    for (const [key, value] of Object.entries(bag)) {
      const lc = normalizeKey(key);
      if (lc === "category_for_filter" || lc === "subcategory" || lc === "product_type" || lc === "producttype") return value;
    }
  }

  return undefined;
}

function flattenAttributeValues(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(flattenAttributeValues);
  if (typeof value === "object") return Object.values(value).flatMap(flattenAttributeValues);
  return [String(value)];
}

function normalizeCategoryForMatch(raw) {
  const normalized = normalizeCategory(raw);
  if (normalized) return normalized;
  return String(raw || "").toLowerCase().trim().replace(/[_\s]+/g, "-");
}

function rawCategoryValueMatches(raw, targetCategory) {
  const target = normalizeCategoryForMatch(targetCategory);
  if (!target) return true;
  const values = flattenAttributeValues(raw);
  for (const value of values) {
    if (normalizeCategoryForMatch(value) === target) return true;
    const words = String(value || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    for (let size = Math.min(3, words.length); size >= 1; size--) {
      for (let i = 0; i <= words.length - size; i++) {
        if (normalizeCategoryForMatch(words.slice(i, i + size).join(" ")) === target) {
          return true;
        }
      }
    }
  }
  return false;
}

export function productMatchesCategoryConstraint(product, category) {
  const target = normalizeCategoryForMatch(category);
  if (!target) return true;
  const attrs = product?.attributesJson || product?.attributes || {};
  const strongValues = [
    readAttributeCI(attrs, ["category", "category_for_filter", "subcategory", "product_type", "productType"]),
    product?.productType,
    product?.product_type,
  ];
  if (strongValues.some((value) => rawCategoryValueMatches(value, target))) return true;

  // Fallback for imperfect catalog rows: use title/tags, but never the
  // description. Descriptions often mention adjacent categories and would
  // let a pink sneaker leak into a pink sandals request.
  const fallbackValues = [
    product?.title,
    Array.isArray(product?.tags) ? product.tags.join(" ") : product?.tags,
  ];
  return fallbackValues.some((value) => rawCategoryValueMatches(value, target));
}

export function attributeValueMatches(value, wants, { normalizer = null } = {}) {
  const wantList = Array.from(wants || []).map((w) => String(w || "").toLowerCase().trim()).filter(Boolean);
  if (wantList.length === 0) return true;
  const values = flattenAttributeValues(value);
  for (const raw of values) {
    const normalized = normalizer ? normalizer(raw) : null;
    const text = String(raw || "").toLowerCase();
    for (const want of wantList) {
      if (normalized && normalized === want) return true;
      if (text.includes(want)) return true;
    }
  }
  return false;
}

export function deriveCatalogMatchContract({ products = [], constraints = {}, relaxedFilters = null, impossibleConstraints = [] } = {}) {
  const canonical = canonicalizeCatalogConstraints(constraints);
  const exactCount = Array.isArray(products) ? products.length : 0;
  if (exactCount > 0 && !relaxedFilters) {
    return { status: "exact_match", constraints: canonical, exactCount };
  }
  if (exactCount > 0 && relaxedFilters) {
    return { status: "near_match", constraints: canonical, exactCount, relaxedFilters };
  }
  if (Array.isArray(impossibleConstraints) && impossibleConstraints.length > 0) {
    return { status: "true_no_match", constraints: canonical, exactCount: 0, impossibleConstraints };
  }
  return { status: "needs_more_info", constraints: canonical, exactCount: 0 };
}
