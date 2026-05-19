// Catalog resolver (Milestone 1).
//
// Constraint-propagation layer that sits between the customer
// message and Claude. Reads the CatalogFacetIndex (a per-shop
// pre-computed matrix) and CatalogFact rows to produce structured
// resolver state:
//
//   {
//     matched_constraints:      { color: "red" }
//     inferred_constraints:     { gender: { value: "women", reason: "..." } }
//     impossible_constraints:   [{ field: "color", value: "pink", reason: "..." }]
//     remaining_disambiguators: ["size"]
//     do_not_ask:               ["gender", "color"]
//     candidate_products:       [{ handle, title, why_recommended, availability }]
//     recommended_next_action:  { type: "recommend" | "ask" | "no_match" | "controlled_oos" | "skip", ... }
//   }
//
// Called from chat.jsx ONLY for product-shopping turns (greetings,
// brand info, policy, capability checks about prior cards bypass
// this layer). The resolver itself returns
// `{ type: "skip", reason: ... }` when it can't add value (e.g., the
// catalog facet index hasn't been built yet for this shop, or no
// useful constraints could be extracted from the input).
//
// Reuses existing data: getCategoryGenderAvailability already lives
// in app/models/Product.server.js; we lean on the new
// CatalogFacetIndex for the rest. We do NOT duplicate the existing
// search_products logic — the resolver returns a structured
// constraint state and a candidate-product preview. search_products
// continues to do the heavy keyword + semantic + filter-wipeout work
// when needed, but it now also reads ctx.resolverState to skip
// redundant disambiguation.

import prisma from "../db.server.js";
import { getCatalogFacetIndex, __internals as catalogFactInternals } from "./catalog-facts.server.js";

// ─── helpers ───────────────────────────────────────────────────

// Internal "fact" with confidence + source metadata. The LLM only
// sees { value, reason } — confidence and source are logged for
// debugging and used to break ties.
function mkFact(value, reason, source, confidence = 1.0) {
  return { value, reason, source, confidence };
}

const {
  normalizeColor: normalizeCatalogColor,
  normalizeCategory: normalizeCatalogCategory,
  normalizeGender: normalizeCatalogGender,
} = catalogFactInternals;

function canonicalizeResolverConstraints(input = {}) {
  const out = { ...input };
  if (out.gender) {
    out.gender = normalizeCatalogGender(out.gender) || String(out.gender).toLowerCase().trim();
  }
  if (out.category) {
    out.category = normalizeCatalogCategory(out.category) || String(out.category).toLowerCase().trim().replace(/\s+/g, "-");
  }
  if (out.color) {
    out.color = normalizeCatalogColor(out.color) || String(out.color).toLowerCase().trim();
  }
  return out;
}

// Build sessionMemory facts dictionary from existing
// conversation-memory output. extractAnsweredChoices returns
// { gender, useCase, condition, arch, overpronation } shape.
function sessionMemoryFromAnsweredChoices(answeredChoices = {}) {
  const out = { explicit: {}, inferred: {} };
  for (const [k, v] of Object.entries(answeredChoices)) {
    if (v == null || v === "") continue;
    out.explicit[k] = String(v).toLowerCase();
  }
  return out;
}

// ─── core resolver ─────────────────────────────────────────────

// Map of which fields are "required" for a recommendation. A turn
// can recommend only when matched + inferred + session memory
// covers gender + category (the catalog's structural primary key).
const REQUIRED_FIELDS = ["gender", "category"];

// ─── constraint propagation ───────────────────────────────────
//
// Generic domain-of-possible-values computation. We flatten the
// facet index into the set of (gender, category, color) tuples that
// actually exist in the catalog, then filter that tuple space by
// the known constraints. Projecting the surviving tuples onto an
// unresolved field gives that field's possible-value domain.
//
//   domain.length === 1 → inferred
//   domain.length === 0 → impossible (Phase 1 already surfaces the
//                         pair-wise impossibility before we get here;
//                         this layer is for inference only)
//   domain.length  > 1 → remains a valid disambiguator
//
// This generalizes the previous one-field-at-a-time helpers
// (inferGenderFromColor, inferGenderFromCategory) so that any
// combination of known constraints narrows the others. Example:
// {color:"red", category:"sandals"} → if the only (gender, sandals,
// red) tuple has gender="women", gender is inferred even when "red"
// alone exists in multiple genders.

function buildTupleSpace(facetIndex) {
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
  // Some (gender, category) combos may have no color data baked into
  // the index — still record them so gender/category inference works
  // when color is the unknown.
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

function tupleMatches(tuple, constraints) {
  if (constraints.gender && tuple.gender && tuple.gender !== "unisex" && tuple.gender !== constraints.gender) {
    return false;
  }
  if (constraints.category && tuple.category && tuple.category !== constraints.category) {
    return false;
  }
  if (constraints.color != null && tuple.color != null && tuple.color !== constraints.color) {
    return false;
  }
  return true;
}

function projectField(tuples, constraints, field) {
  const out = new Set();
  for (const t of tuples) {
    if (!tupleMatches(t, constraints)) continue;
    const v = t[field];
    if (v == null) continue;
    // "unisex" is a product-tagging convention, not a customer-pickable
    // gender — drop it from the domain so it's never inferred or
    // surfaced as a chip option.
    if (field === "gender" && v === "unisex") continue;
    out.add(v);
  }
  return Array.from(out);
}

function describeContext(known, exceptField) {
  const parts = [];
  if (exceptField !== "color" && known.color) parts.push(known.color);
  if (exceptField !== "gender" && known.gender) parts.push(`${known.gender}'s`);
  if (exceptField !== "category" && known.category) parts.push(known.category);
  return parts.join(" ");
}

function buildInferenceReason(field, value, known) {
  const ctx = describeContext(known, field);
  if (field === "gender") {
    return ctx ? `${ctx} only exists in ${value}'s products` : `only ${value}'s available`;
  }
  if (field === "category") {
    return ctx ? `${ctx} is only available in ${value}` : `only ${value} available`;
  }
  if (field === "color") {
    return ctx ? `${ctx} only comes in ${value}` : `only ${value} available`;
  }
  return `${field} narrows to ${value}`;
}

// Public: compute possible domains for every unresolved tuple field
// given the known constraints. Returns:
//   { gender: { domain: [...], inferred?: <value> }, category: ..., color: ... }
// Fields that are already known are omitted from the output.
function computeConstraintDomains(known, facetIndex) {
  const tuples = buildTupleSpace(facetIndex);
  const fields = ["gender", "category", "color"];
  const out = {};
  for (const field of fields) {
    if (known[field] != null) continue;
    const domain = projectField(tuples, known, field);
    out[field] = { domain };
    if (domain.length === 1) out[field].inferred = domain[0];
  }
  return out;
}

// Phase-1 helper kept for compatibility: does (color, gender,
// category) exist anywhere in the catalog? Implemented on top of the
// tuple space so its semantics stay in sync with inference.
function colorExistsInScope(color, gender, category, facetIndex) {
  if (!color || !facetIndex) return null;
  const tuples = buildTupleSpace(facetIndex);
  const constraints = { color };
  if (gender) constraints.gender = gender;
  if (category) constraints.category = category;
  for (const t of tuples) {
    if (t.color == null) continue;
    if (tupleMatches(t, constraints) && t.color === color) return true;
  }
  return false;
}

// Look up candidate products from CatalogFact for the resolved
// scope. Filters OOS unless includeOos=true (used by the controlled-
// OOS path when a specific variant was requested).
async function fetchCandidates({ shop, gender, category, color, condition, includeOos = false, limit = 6 }) {
  const where = { shop };
  if (!includeOos) where.available = true;
  if (category) where.category = category;
  if (gender) where.gender = { has: gender };
  if (color) where.colors = { has: color };
  if (condition) where.conditionTags = { has: condition };
  where.variantId = null; // product-level rows only for candidates

  const facts = await prisma.catalogFact.findMany({
    where,
    take: limit,
    orderBy: { syncedAt: "desc" },
    select: {
      productHandle: true, title: true, available: true,
      gender: true, colors: true, category: true,
      conditionTags: true, totalInventory: true,
    },
  });

  return facts.map((f) => ({
    handle: f.productHandle,
    title: f.title,
    availability: f.available ? (f.totalInventory > 5 ? "in_stock" : "low_stock") : "out_of_stock",
    why_recommended: [
      ...(color && f.colors.includes(color) ? [`matches ${color}`] : []),
      ...(condition && f.conditionTags.includes(condition) ? [`good for ${condition.replace(/_/g, " ")}`] : []),
      f.available ? "in stock" : "out of stock",
    ],
  }));
}

// ─── public API ────────────────────────────────────────────────

// Main entry. Returns a ResolverOutput or a skip signal.
//
// userConstraints is the structured extraction from classifier
// (gender, category, color, etc). messages is the full conversation
// history (used to detect "specific product + attribute" requests
// for the controlled-OOS path). sessionMemory is derived from
// conversation-memory's answered choices.
export async function resolveCatalogTurn({
  shop,
  query = "",
  userConstraints = {},
  sessionMemory = {},
  messages = [],
  // Test-only injection points. Production code never passes these.
  _testFacetIndex,
  _testFetchCandidates,
  _testFindOos,
}) {
  // Skip early if we have no scope to work with.
  const facetIndex = _testFacetIndex !== undefined
    ? _testFacetIndex
    : await getCatalogFacetIndex(shop);
  if (!facetIndex) {
    return {
      type: "skip",
      reason: "facet_index_not_built",
    };
  }

  // Merge user constraints + session memory. User-provided wins.
  const merged = canonicalizeResolverConstraints({ ...sessionMemory.explicit, ...userConstraints });
  // Strip nulls.
  for (const k of Object.keys(merged)) if (merged[k] == null || merged[k] === "") delete merged[k];

  // ── Phase 1: separate matched vs impossible ──────────────────
  const matched_constraints = {};
  const impossible_constraints = [];
  const internal_inferred = {};  // with confidence + source metadata
  const inferred_constraints = {};

  const categoryByGender = facetIndex.categoryByGender || {};
  const knownCategories = new Set(Object.keys(categoryByGender));

  // Category check
  if (merged.category) {
    if (knownCategories.has(merged.category)) {
      matched_constraints.category = merged.category;
    } else {
      impossible_constraints.push({
        field: "category",
        value: merged.category,
        reason: `we don't carry a "${merged.category}" category`,
      });
    }
  }

  // Gender check
  if (merged.gender) {
    if (merged.category && categoryByGender[merged.category]) {
      const validGendersForCat = categoryByGender[merged.category];
      if (validGendersForCat.includes(merged.gender) || validGendersForCat.includes("unisex")) {
        matched_constraints.gender = merged.gender;
      } else {
        impossible_constraints.push({
          field: "gender",
          value: merged.gender,
          reason: `${merged.category} only exists in ${validGendersForCat.join(" / ")}`,
        });
      }
    } else {
      matched_constraints.gender = merged.gender;
    }
  }

  // Color check (in scope of category + gender if known)
  if (merged.color) {
    const scopeGender = matched_constraints.gender;
    const scopeCategory = matched_constraints.category;
    const exists = colorExistsInScope(merged.color, scopeGender, scopeCategory, facetIndex);
    if (exists) {
      matched_constraints.color = merged.color;
    } else if (exists === false) {
      const scopeLabel = [scopeGender, scopeCategory].filter(Boolean).join(" ") || "the catalog";
      impossible_constraints.push({
        field: "color",
        value: merged.color,
        reason: `no ${merged.color} products in ${scopeLabel}`,
      });
    }
  }

  // Carry through condition / useCase / size as matched if present
  // (we don't validate condition existence — search will).
  for (const k of ["condition", "useCase", "size", "width", "priceMax"]) {
    if (merged[k] != null) matched_constraints[k] = merged[k];
  }

  // Surface a customer-named specific product so the orthotic gate's
  // Case D yield can detect it. The controlled_oos path also reads
  // userConstraints.specificProduct directly; this just makes the
  // value visible in resolverState for downstream consumers.
  if (userConstraints.specificProduct) {
    matched_constraints.specificProduct = userConstraints.specificProduct;
  }

  // ── Phase 2: constraint propagation ──────────────────────────
  //
  // Compute the possible-value domain for every unresolved tuple
  // field (gender, category, color) under the conjunction of all
  // matched constraints. A singleton domain is inferred. This
  // generalizes the previous one-field-at-a-time helpers so that,
  // e.g., {color:"red", category:"sandals"} narrows gender even
  // when "red" alone exists in multiple genders.
  {
    const known = {};
    if (matched_constraints.gender) known.gender = matched_constraints.gender;
    if (matched_constraints.category) known.category = matched_constraints.category;
    if (matched_constraints.color) known.color = matched_constraints.color;
    const domains = computeConstraintDomains(known, facetIndex);
    for (const [field, info] of Object.entries(domains)) {
      if (info.inferred == null) continue;
      const reason = buildInferenceReason(field, info.inferred, known);
      internal_inferred[field] = mkFact(info.inferred, reason, "constraint_propagation", 0.95);
      inferred_constraints[field] = { value: info.inferred, reason };
    }
  }

  // ── Phase 3: compute do_not_ask + remaining_disambiguators ──
  const resolvedFields = new Set([
    ...Object.keys(matched_constraints),
    ...Object.keys(inferred_constraints),
  ]);
  const impossibleFields = new Set(impossible_constraints.map((c) => c.field));

  // do_not_ask: resolved fields + fields that are determined-impossible
  const do_not_ask = Array.from(new Set([
    ...resolvedFields,
    ...impossibleFields,
  ]));

  // remaining_disambiguators: required fields not yet resolved
  const remaining_disambiguators = REQUIRED_FIELDS.filter(
    (f) => !resolvedFields.has(f) && !impossibleFields.has(f),
  );

  // ── Phase 4: pick recommended_next_action ────────────────────

  // If any constraint is impossible, surface that first.
  if (impossible_constraints.length > 0) {
    const candidates = await (_testFetchCandidates || fetchCandidates)({
      shop,
      // Drop the impossible constraint when fetching alternatives:
      gender: matched_constraints.gender,
      category: matched_constraints.category,
    });
    return {
      type: "resolver_state",
      matched_constraints,
      inferred_constraints,
      impossible_constraints,
      remaining_disambiguators,
      do_not_ask,
      candidate_products: candidates,
      recommended_next_action: {
        type: "no_match",
        reason: impossible_constraints.map((c) => c.reason).join("; "),
        alternatives: candidates.slice(0, 3).map((c) => c.title),
      },
      _internal: { inferred_meta: internal_inferred },
    };
  }

  // If we have gender + category resolved, recommend.
  const effectiveGender = matched_constraints.gender || inferred_constraints.gender?.value;
  const effectiveCategory = matched_constraints.category;

  if (effectiveGender && effectiveCategory) {
    const candidates = await (_testFetchCandidates || fetchCandidates)({
      shop,
      gender: effectiveGender,
      category: effectiveCategory,
      color: matched_constraints.color,
      condition: matched_constraints.condition,
    });

    // Controlled-OOS path: if the user asked for a specific product
    // (the query string names a single product) + an OOS attribute,
    // we want controlled_oos action, not no_match. For M1 we keep
    // this conservative — only fire when caller marked it via
    // userConstraints.specificProduct.
    if (userConstraints.specificProduct && candidates.length === 0) {
      const oosFacts = _testFindOos
        ? await _testFindOos(userConstraints.specificProduct)
        : await prisma.catalogFact.findFirst({
            where: { shop, productHandle: userConstraints.specificProduct, variantId: null },
            select: { productHandle: true, title: true },
          });
      if (oosFacts) {
        return {
          type: "resolver_state",
          matched_constraints,
          inferred_constraints,
          impossible_constraints,
          remaining_disambiguators,
          do_not_ask,
          candidate_products: [],
          recommended_next_action: {
            type: "controlled_oos",
            product_handle: oosFacts.productHandle,
            product_title: oosFacts.title,
            pdp_url: `/products/${oosFacts.productHandle}`,
            oos_attribute: matched_constraints.size || matched_constraints.color || "this variant",
          },
          _internal: { inferred_meta: internal_inferred },
        };
      }
    }

    return {
      type: "resolver_state",
      matched_constraints,
      inferred_constraints,
      impossible_constraints,
      remaining_disambiguators,
      do_not_ask,
      candidate_products: candidates,
      recommended_next_action: candidates.length > 0
        ? { type: "recommend", reason: `${candidates.length} products match` }
        : effectiveCategory === "orthotics"
          // Orthotic-domain ownership (M2 routing correctness):
          // empty CatalogFact preview for orthotics doesn't mean the
          // catalog lacks them — orthotic SKUs live in the merchant's
          // recommender masterIndex and are picked by clinical
          // attributes (condition / arch / useCase / overpronation),
          // not by gender+category alone. Defer to the orthotic
          // recommender flow rather than asserting no_match.
          ? { type: "skip", reason: "orthotic_recommender_owns_clinical_attrs" }
          // Empty candidate preview with NO impossible constraint
          // isn't authoritative — it could be a facet-index lag, an
          // untracked-inventory shape, or a missing attribute. Ask
          // for a disambiguator instead of claiming we don't have it.
          : {
              type: "ask",
              field: "more_attributes",
              chip_options: [],
              reason: "candidate preview empty without an impossible constraint — need more attributes before claiming no match",
            },
      _internal: { inferred_meta: internal_inferred },
    };
  }

  // Otherwise, ask for the highest-impact missing field.
  const askField = remaining_disambiguators[0]; // gender first, then category
  let chipOptions = [];
  if (askField === "gender") {
    // Restrict chip options to genders actually present in scope.
    if (effectiveCategory && categoryByGender[effectiveCategory]) {
      chipOptions = categoryByGender[effectiveCategory].filter((g) => g !== "unisex");
    } else {
      // All genders observed in shop:
      const all = new Set();
      for (const genders of Object.values(categoryByGender)) {
        for (const g of genders) if (g !== "unisex") all.add(g);
      }
      chipOptions = Array.from(all).sort();
    }
  } else if (askField === "category") {
    if (effectiveGender) {
      chipOptions = Object.entries(categoryByGender)
        .filter(([, genders]) => genders.includes(effectiveGender) || genders.includes("unisex"))
        .map(([cat]) => cat)
        .sort();
    } else {
      chipOptions = Object.keys(categoryByGender).sort();
    }
  }

  return {
    type: "resolver_state",
    matched_constraints,
    inferred_constraints,
    impossible_constraints,
    remaining_disambiguators,
    do_not_ask,
    candidate_products: [],
    recommended_next_action: askField
      ? {
          type: "ask",
          field: askField,
          chip_options: chipOptions,
          reason: `need ${askField} to narrow recommendations`,
        }
      : { type: "skip", reason: "nothing to disambiguate" },
    _internal: { inferred_meta: internal_inferred },
  };
}

// Build the system-prompt block from a resolver state. Returns ""
// when the resolver returned skip — so the chat route can blindly
// concatenate the result.
export function buildResolverStatePromptBlock(resolverState) {
  if (!resolverState || resolverState.type !== "resolver_state") return "";

  const lines = [
    "",
    "=== RESOLVER STATE (ground truth for this turn) ===",
    "This is precomputed from the live catalog. Treat as truth.",
    "",
    `matched_constraints: ${JSON.stringify(resolverState.matched_constraints)}`,
    `inferred_constraints: ${JSON.stringify(resolverState.inferred_constraints)}`,
    `impossible_constraints: ${JSON.stringify(resolverState.impossible_constraints)}`,
    `remaining_disambiguators: ${JSON.stringify(resolverState.remaining_disambiguators)}`,
    `do_not_ask: ${JSON.stringify(resolverState.do_not_ask)}`,
    `candidate_products: ${JSON.stringify(
      (resolverState.candidate_products || []).map(({ handle, title, availability }) => ({ handle, title, availability }))
    )}`,
    `recommended_next_action: ${JSON.stringify(resolverState.recommended_next_action)}`,
    "",
    "Resolver-state rules:",
    "1. Treat resolver state as truth. Do NOT search again unless the customer changed scope.",
    "2. NEVER ask about any field listed in do_not_ask. They are already resolved.",
    "3. If inferred_constraints contains a field, naturally mention the inference. Example: 'Since red only comes in our women's line — here are the red women's options.'",
    "4. If impossible_constraints is non-empty, say so plainly before offering alternatives.",
    "5. recommended_next_action drives your response shape:",
    "   - recommend → introduce candidate_products in 1 sentence; cards render below.",
    "   - ask → ask ONLY that one field, using chip_options exactly.",
    "   - no_match → this only fires when impossible_constraints names a specific impossibility (e.g. color in this gender+category). Name THAT specific impossibility honestly (\"no exact red in men's sneakers — closest are navy and black\") and offer the alternatives. NEVER turn this into a blanket stock denial like \"we don't have <category>\" or \"<category> isn't in stock\" — that's catalog-level, not constraint-level.",
    "   - controlled_oos → use the OOS phrasing: '[Product] in [attribute] isn't currently in stock — visit the product page to sign up for back-in-stock alerts.'",
    "   - skip → resolver had nothing to add; use normal reasoning. NEVER state or imply that the catalog lacks the requested category just because skip fired.",
    "6. NEVER invent product names, colors, sizes, or prices. If it's not in candidate_products or search results, it doesn't exist for this turn.",
    "",
  ];

  return lines.join("\n");
}

// Lightweight constraint extractor for the resolver preflight.
// Scans the latest user message against the facet index and synonym
// maps. Returns { gender?, category?, color?, condition?, useCase? }.
// Intentionally narrow — we only extract things the resolver can
// validate against the catalog. Anything subtler is left to search.
const RESOLVER_COLOR_LEX = {
  burgundy: "burgundy", wine: "burgundy", maroon: "burgundy",
  navy: "navy",
  cognac: "cognac", tan: "tan", camel: "tan",
  charcoal: "charcoal", gray: "gray", grey: "gray",
  white: "white", ivory: "white", cream: "white",
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
const RESOLVER_GENDER_LEX = {
  "men's": "men", mens: "men", men: "men", male: "men", man: "men", guy: "men", guys: "men",
  "women's": "women", womens: "women", women: "women", female: "women", woman: "women", ladies: "women",
  kids: "kids", kid: "kids", child: "kids", children: "kids", youth: "kids", boy: "kids", girl: "kids", son: "kids", daughter: "kids",
  unisex: "unisex",
};
const RESOLVER_CATEGORY_LEX = {
  sneakers: "sneakers", sneaker: "sneakers", trainers: "sneakers", trainer: "sneakers",
  sandals: "sandals", sandal: "sandals", slides: "sandals",
  boots: "boots", boot: "boots", booties: "boots",
  loafers: "loafers", loafer: "loafers",
  oxfords: "oxfords", oxford: "oxfords",
  clogs: "clogs", clog: "clogs",
  "slip-ons": "slip-ons", "slip-on": "slip-ons",
  slippers: "slippers", slipper: "slippers",
  "mary janes": "mary-janes", "mary-janes": "mary-janes",
  heels: "wedges-heels", wedges: "wedges-heels",
  orthotics: "orthotics", orthotic: "orthotics", insoles: "orthotics", insole: "orthotics",
  accessories: "accessories", accessory: "accessories",
};
const RESOLVER_CONDITION_RE = {
  plantar_fasciitis: /\bplantar(?:\s+fasciitis)?\b/i,
  flat_feet: /\b(?:flat\s+feet|low\s+arch|fallen\s+arches?)\b/i,
  high_arch: /\bhigh\s+arch\b/i,
  bunions: /\bbunion(?:s|ettes?)?\b/i,
  diabetic: /\b(?:diabetic|diabetes)\b/i,
};
const RESOLVER_USECASE_RE = {
  walking: /\bwalking\b/i,
  running: /\brunning\b/i,
  travel: /\btravel\b/i,
  dress: /\b(?:dress|formal|wedding)\b/i,
  athletic: /\b(?:athletic|gym|workout)\b/i,
  hiking: /\bhiking\b/i,
};

function matchLex(text, lex) {
  if (!text) return null;
  const lc = String(text).toLowerCase();
  for (const [key, canonical] of Object.entries(lex)) {
    const re = new RegExp(`(?:^|[^a-z])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z]|$)`, "i");
    if (re.test(lc)) return canonical;
  }
  return null;
}

export function extractUserConstraints(message) {
  if (!message || typeof message !== "string") return {};
  const out = {};
  const gender = matchLex(message, RESOLVER_GENDER_LEX);
  if (gender) out.gender = gender;
  const category = matchLex(message, RESOLVER_CATEGORY_LEX);
  if (category) out.category = category;
  const color = matchLex(message, RESOLVER_COLOR_LEX);
  if (color) out.color = color;
  for (const [tag, re] of Object.entries(RESOLVER_CONDITION_RE)) {
    if (re.test(message)) { out.condition = tag; break; }
  }
  for (const [tag, re] of Object.entries(RESOLVER_USECASE_RE)) {
    if (re.test(message)) { out.useCase = tag; break; }
  }
  return out;
}

// Conservative catalog-based product-name detector.
//
// Used to populate userConstraints.specificProduct so the resolver
// can take the controlled_oos path. Avoids LLM/NER — strictly
// against synced product-level CatalogFact rows. Two-stage match:
//   1. Exact whole-phrase match on product title (case-insensitive).
//   2. If no exact match, unique whole-word match on the first
//      meaningful title token (length ≥ 4) — colors, genders,
//      categories, sizes, and common words are excluded so a bare
//      "Red" or "Sandal" never resolves to a product.
// Returns the matching product handle, or null when zero or
// multiple candidates survive.
const SPECIFIC_PRODUCT_STOPWORDS = new Set([
  // colors
  ...Object.values(RESOLVER_COLOR_LEX),
  // genders
  ...Object.values(RESOLVER_GENDER_LEX),
  // categories (singular & plural normalized)
  ...Object.values(RESOLVER_CATEGORY_LEX),
  // common product-title words
  "the", "and", "with", "for", "from", "shoe", "shoes", "footwear",
  "support", "arch", "insole", "insoles", "orthotic", "orthotics",
  "men", "women", "mens", "womens", "kids", "unisex",
  "leather", "suede", "fabric", "mesh", "knit", "rubber",
  "size", "wide", "narrow", "medium", "standard", "regular",
  "new", "classic", "comfort", "premium", "pro", "edition",
]);

function firstMeaningfulToken(title) {
  if (!title) return null;
  const tokens = String(title).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const tok of tokens) {
    if (tok.length < 4) continue;
    if (SPECIFIC_PRODUCT_STOPWORDS.has(tok)) continue;
    if (/^\d+$/.test(tok)) continue;
    return tok;
  }
  return null;
}

export async function detectSpecificProduct(shop, message, { _testFacts } = {}) {
  if (!shop || !message || typeof message !== "string") return null;
  const text = String(message).trim();
  if (!text) return null;
  const lcText = text.toLowerCase();

  // Fetch catalog product rows (handle + title), variant rows excluded.
  // _testFacts lets the eval suite inject a fixture without touching DB.
  let facts;
  if (Array.isArray(_testFacts)) {
    facts = _testFacts;
  } else {
    facts = await prisma.catalogFact.findMany({
      where: { shop, variantId: null },
      select: { productHandle: true, title: true },
      take: 1000,
    });
  }
  if (!facts || facts.length === 0) return null;

  // Stage 1: exact whole-title phrase match.
  for (const f of facts) {
    const lcTitle = String(f.title || "").toLowerCase().trim();
    if (lcTitle.length < 3) continue;
    const re = new RegExp(`\\b${lcTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lcText)) return f.productHandle;
  }

  // Stage 2: unique first-meaningful-token match.
  const tokenToHandles = new Map();
  for (const f of facts) {
    const tok = firstMeaningfulToken(f.title);
    if (!tok) continue;
    const arr = tokenToHandles.get(tok) || [];
    arr.push(f.productHandle);
    tokenToHandles.set(tok, arr);
  }

  const messageTokens = new Set(
    lcText.split(/[^a-z0-9]+/).filter((t) => t && t.length >= 4 && !SPECIFIC_PRODUCT_STOPWORDS.has(t)),
  );

  const candidates = new Set();
  for (const tok of messageTokens) {
    const handles = tokenToHandles.get(tok);
    if (!handles) continue;
    // Token must map to exactly one product to qualify.
    if (handles.length !== 1) continue;
    candidates.add(handles[0]);
  }
  if (candidates.size !== 1) return null;
  return Array.from(candidates)[0];
}
