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
import { getCatalogFacetIndex } from "./catalog-facts.server.js";
import {
  catalogFieldOptions,
  canonicalizeCatalogConstraints,
  colorExistsInCatalogScope,
  computeCatalogConstraintDomains,
} from "./catalog-matcher.server.js";
import { detectRejectedCategories } from "./chat-postprocessing.js";

// ─── helpers ───────────────────────────────────────────────────

// Internal "fact" with confidence + source metadata. The LLM only
// sees { value, reason } — confidence and source are logged for
// debugging and used to break ties.
function mkFact(value, reason, source, confidence = 1.0) {
  return { value, reason, source, confidence };
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

// Look up candidate products from CatalogFact for the resolved
// scope. Filters OOS unless includeOos=true (used by the controlled-
// OOS path when a specific variant was requested).
async function fetchCandidates({
  shop,
  gender,
  category,
  color,
  condition,
  allowedCategories = [],
  includeOos = false,
  limit = 6,
}) {
  const where = { shop };
  if (!includeOos) where.available = true;
  if (category) where.category = category;
  else if (Array.isArray(allowedCategories) && allowedCategories.length > 0) {
    const normalizedAllowed = allowedCategories
      .map((value) => canonicalizeCatalogConstraints({ category: value }).category)
      .filter(Boolean);
    if (normalizedAllowed.length > 0) where.category = { in: normalizedAllowed };
  }
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
  userConstraints = {},
  sessionMemory = {},
  facetIndex: providedFacetIndex,
  allowedCategories = [],
  // Test-only injection points. Production code never passes these.
  _testFacetIndex,
  _testFetchCandidates,
  _testFindOos,
}) {
  // Skip early if we have no scope to work with.
  const facetIndex = _testFacetIndex !== undefined
    ? _testFacetIndex
    : providedFacetIndex || await getCatalogFacetIndex(shop);
  if (!facetIndex) {
    return {
      type: "skip",
      reason: "facet_index_not_built",
    };
  }

  // Merge user constraints + session memory. User-provided wins.
  const merged = canonicalizeCatalogConstraints({ ...sessionMemory.explicit, ...userConstraints });
  // Strip nulls.
  for (const k of Object.keys(merged)) if (merged[k] == null || merged[k] === "") delete merged[k];

  // ── Phase 1: separate matched vs impossible ──────────────────
  const matched_constraints = {};
  const impossible_constraints = [];
  const internal_inferred = {};  // with confidence + source metadata
  const inferred_constraints = {};

  const categoryByGender = facetIndex.categoryByGender || {};
  const knownCategories = new Set(Object.keys(categoryByGender));
  const normalizedAllowedCategories = Array.isArray(allowedCategories)
    ? allowedCategories
        .map((value) => canonicalizeCatalogConstraints({ category: value }).category)
        .filter(Boolean)
    : [];
  const hasActiveCategoryGroup = normalizedAllowedCategories.length > 0;
  const categoryIsKnownSpecific = merged.category && knownCategories.has(merged.category);
  const categoryIsGroupUmbrella =
    merged.category &&
    !categoryIsKnownSpecific &&
    hasActiveCategoryGroup;

  // Broad shopping nouns such as "shoes" / "footwear" describe the
  // merchant's active category group, not a literal product category.
  // Keep allowedCategories as the catalog scope and drop the fake
  // category so stale memory (for example orthotics from the previous
  // turn) cannot hijack a broad "pink shoes" request.
  if (categoryIsGroupUmbrella) {
    delete merged.category;
  }

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
    const exists = colorExistsInCatalogScope(
      merged.color,
      scopeGender,
      scopeCategory,
      facetIndex,
      { allowedCategories: scopeCategory ? [] : allowedCategories },
    );
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
    const domains = computeCatalogConstraintDomains(known, facetIndex, { allowedCategories });
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
    // Alternatives must remain inside the customer's active product
    // group. A broad no-match such as "pink men's shoes" must never
    // suggest men's orthotics merely because both share the gender.
    // When there is no category or active-group scope, do not invent
    // broad alternatives; the assistant can ask for a valid pivot.
    const canGroundAlternatives =
      Boolean(matched_constraints.category) ||
      (Array.isArray(allowedCategories) && allowedCategories.length > 0);
    const candidates = canGroundAlternatives
      ? await (_testFetchCandidates || fetchCandidates)({
          shop,
          // Drop only the impossible constraint when fetching alternatives.
          gender: matched_constraints.gender,
          category: matched_constraints.category,
          allowedCategories: matched_constraints.category ? [] : allowedCategories,
        })
      : [];
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
  const effectiveCategory = matched_constraints.category || inferred_constraints.category?.value;

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
    // Project from the exact live tuple intersection. This prevents a
    // broad "pink shoes" request from offering Men's/Kids merely because
    // those genders exist elsewhere in the shop.
    chipOptions = catalogFieldOptions(
      facetIndex,
      {
        category: effectiveCategory,
        color: matched_constraints.color,
      },
      "gender",
      { allowedCategories },
    );
  } else if (askField === "category") {
    chipOptions = catalogFieldOptions(
      facetIndex,
      {
        gender: effectiveGender,
        color: matched_constraints.color,
      },
      "category",
      { allowedCategories },
    );
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
  white: "white", ivory: "white", cream: "white", blanco: "white", blanca: "white", blancos: "white", blancas: "white",
  black: "black", negro: "black", negra: "black", negros: "black", negras: "black",
  brown: "brown", chocolate: "brown", walnut: "brown", chestnut: "brown", marron: "brown", "marrón": "brown", marrones: "brown", cafe: "brown", "café": "brown", cafes: "brown", "cafés": "brown",
  red: "red", rojo: "red", roja: "red", rojos: "red", rojas: "red",
  pink: "pink", rose: "pink", coral: "pink", rosa: "pink", rosas: "pink",
  blue: "blue", denim: "blue", azul: "blue", azules: "blue",
  green: "green", olive: "green", sage: "green", verde: "green", verdes: "green",
  yellow: "yellow", mustard: "yellow", honey: "yellow", amarillo: "yellow", amarilla: "yellow", amarillos: "yellow", amarillas: "yellow",
  orange: "orange", naranja: "orange", naranjas: "orange",
  purple: "purple", violet: "purple", morado: "purple", morada: "purple", morados: "purple", moradas: "purple", violeta: "purple", violetas: "purple",
  gold: "gold", silver: "silver", bronze: "bronze", taupe: "taupe",
};
const RESOLVER_GENDER_LEX = {
  "men's": "men", mens: "men", men: "men", male: "men", man: "men", guy: "men", guys: "men",
  "women's": "women", womens: "women", women: "women", female: "women", woman: "women", ladies: "women",
  kids: "kids", kid: "kids", child: "kids", children: "kids", youth: "kids", boy: "kids", girl: "kids", son: "kids", daughter: "kids",
  unisex: "unisex",
};
const RESOLVER_CATEGORY_LEX = {
  shoes: "footwear", shoe: "footwear", footwear: "footwear",
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

function matchLexWhere(text, lex, predicate) {
  if (!text) return null;
  const lc = String(text).toLowerCase();
  for (const [key, canonical] of Object.entries(lex)) {
    const re = new RegExp(`(?:^|[^a-z])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z]|$)`, "i");
    if (re.test(lc) && predicate(canonical, key)) return canonical;
  }
  return null;
}

// Stem-aware membership test against the rejected-category set
// produced by detectRejectedCategories. The detector's output uses
// the customer's own surface form (e.g. "sneakers"), the canonical
// values use the resolver's normalized form (e.g. "sneakers" — or
// "wedges-heels" for heels). Compare on a normalized singular stem
// so "sneaker" vs "sneakers" and hyphenated canonicals both match.
function categoryIsRejected(canonical, rejectedSet) {
  if (!rejectedSet || rejectedSet.size === 0 || !canonical) return false;
  const stems = new Set();
  for (const part of String(canonical).split("-")) {
    const norm = part.trim().toLowerCase();
    if (!norm) continue;
    stems.add(norm);
    stems.add(norm.endsWith("s") ? norm.slice(0, -1) : `${norm}s`);
  }
  for (const term of rejectedSet) {
    const t = String(term).toLowerCase().trim();
    const tStem = t.endsWith("s") ? t.slice(0, -1) : t;
    if (stems.has(t) || stems.has(tStem)) return true;
  }
  return false;
}

// Garment words the customer might wear (and color-describe) WITHOUT
// asking for footwear in that color. Production trace: "do you have any
// wedge that goes well with my blue dress?" — the lex extractor grabbed
// color=blue from "blue dress", which then forced a blue-wedge search.
// "blue dress" is what they're wearing, not what they want on their
// feet. When a color appears IMMEDIATELY before one of these words, the
// color describes the garment — drop it.
//
// Special case: "dress" can mean either the garment OR the occasion
// modifier ("dress shoes", "dress heels"). The garment check below
// disambiguates by looking one word further: "[color] dress shoes" =
// dress is an occasion → keep the color; "[color] dress" with no
// trailing footwear noun = dress is a garment → drop.
const GARMENT_NOUNS = [
  "dress", "dresses", "gown", "gowns", "skirt", "skirts", "pants",
  "trousers", "jeans", "shorts", "leggings", "shirt", "shirts",
  "blouse", "top", "tops", "sweater", "sweaters", "jacket", "jackets",
  "coat", "coats", "suit", "suits", "tuxedo", "jumpsuit", "romper",
  "outfit", "outfits", "bag", "bags", "purse", "handbag", "clutch",
  "belt", "belts", "scarf", "hat", "tie", "tights", "stockings",
];
const GARMENT_NOUNS_RE_SRC = GARMENT_NOUNS.join("|");
const FOOTWEAR_NOUNS = [
  ...Object.keys(RESOLVER_CATEGORY_LEX),
  "shoes", "shoe", "footwear", "pair", "pairs",
];
const FOOTWEAR_NOUNS_RE_SRC = FOOTWEAR_NOUNS
  .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

// True when "[colorWord] [garment]" appears in the message AND the
// garment is NOT immediately followed by a footwear noun (so
// "pink dress shoes" keeps pink — "dress" is the occasion, not the
// garment). Returns true → drop this color word's match.
function colorMatchIsGarmentAttached(message, colorWord) {
  // "[colorWord] [garment] [footwear-noun]" — keep (dress as occasion).
  const occasionPattern = new RegExp(
    `\\b${colorWord}\\b\\s+(?:${GARMENT_NOUNS_RE_SRC})\\s+(?:${FOOTWEAR_NOUNS_RE_SRC})\\b`,
    "i",
  );
  if (occasionPattern.test(message)) return false;
  // "[colorWord] [garment]" without trailing footwear → drop.
  const garmentPattern = new RegExp(
    `\\b${colorWord}\\b\\s+(?:${GARMENT_NOUNS_RE_SRC})\\b`,
    "i",
  );
  return garmentPattern.test(message);
}

// Pick the color the customer actually wants ON THEIR FEET. Walk every
// color key, drop ones attached to a garment, prefer ones adjacent to a
// footwear noun, otherwise return any non-garment match. Returns the
// canonical color value or null.
function pickCustomerColor(message) {
  const messageLower = String(message).toLowerCase();
  const matches = []; // { key, canonical, index, attachedToFootwear }
  for (const [key, canonical] of Object.entries(RESOLVER_COLOR_LEX)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const re = new RegExp(`(?:^|[^a-z])${escaped}(?:[^a-z]|$)`, "i");
    const m = re.exec(messageLower);
    if (!m) continue;
    if (colorMatchIsGarmentAttached(messageLower, key)) continue;
    const footwearAdj = new RegExp(`\\b${escaped}\\b\\s+(?:${FOOTWEAR_NOUNS_RE_SRC})\\b`, "i").test(messageLower);
    matches.push({ key, canonical, index: m.index, attachedToFootwear: footwearAdj });
  }
  if (matches.length === 0) return null;
  // Prefer a color directly modifying a footwear noun ("red sandals").
  const footwearAdj = matches.find((m) => m.attachedToFootwear);
  return (footwearAdj || matches[0]).canonical;
}

export function extractUserConstraints(message) {
  if (!message || typeof message !== "string") return {};
  const out = {};
  const gender = matchLex(message, RESOLVER_GENDER_LEX);
  if (gender) out.gender = gender;
  // Negation-aware category extraction. When the customer says
  // "besides sneakers" / "other than boots" / "no heels", the lex
  // matcher would still grab the rejected term as a positive
  // category constraint — then the rest of the pipeline searches
  // for the very thing the customer just ruled out. Pre-compute
  // the rejection set with the shared detector and skip any
  // category whose canonical form (or its singular/plural stem)
  // appears in that set.
  const rejected = detectRejectedCategories(message);
  const category = matchLexWhere(
    message,
    RESOLVER_CATEGORY_LEX,
    (canonical) => !categoryIsRejected(canonical, rejected),
  );
  if (category) {
    out.category = category;
  }
  const color = pickCustomerColor(message);
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
  // common use-case verbs/nouns the AI mentions alongside an activity
  "hiking", "walking", "running", "standing", "travel", "traveling",
  "work", "working", "casual", "dress", "formal", "athletic", "sport", "sports",
  "indoor", "outdoor", "everyday",
  // geographic terms — customers say "hiking in Italy", "trip to Paris",
  // etc. None of these are products in any reasonable footwear catalog.
  "italy", "france", "spain", "europe", "england", "germany", "japan",
  "china", "india", "korea", "thailand", "vietnam", "australia", "canada",
  "mexico", "brazil", "africa", "asia", "america", "states",
  "paris", "london", "rome", "milan", "berlin", "tokyo", "york", "boston",
  "chicago", "miami", "vegas", "angeles", "francisco", "seattle", "denver",
  "atlanta", "dallas", "houston", "phoenix", "disney", "disneyland", "disneyworld",
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

// Permissive named-product resolver for similar-product turns.
//
// detectSpecificProduct above requires the matched token to be
// UNIQUE to one product family — a safety property when the caller
// will route the entire turn based on the resolution. That's too
// strict for "similar to X" / "same support as X" / "like the X"
// anchors: catalogs frequently carry several products in one style
// family (e.g. "Jillian Sport Sandal", "Jillian Braided", "Jillian
// Antique Rose") and any single handle is a valid anchor — the
// downstream find_similar_products handler excludes the entire
// style family by titleStyleFamily anyway, so the customer never
// sees the anchor itself recommended back.
//
// Stages:
//   1. Pull a likely anchor phrase out of the message after
//      "like (the)" / "as" / "similar to" / "comparable to" /
//      "same (support|cushioning|fit|…) as" anchors.
//   2. Whole-word match the anchor against catalog titles. Return
//      the first handle whose title contains it.
//   3. Fallback — scan the message for any meaningful token (4+
//      chars, not a stopword) that appears in a catalog title and
//      return the first such handle.
//
// Returns a productHandle string or null. _testFacts injects a
// fixture array for offline tests (same shape as detectSpecificProduct).
const SIMILAR_ANCHOR_EXTRACT_RE =
  /\b(?:similar\s+to|comparable\s+to|like(?:\s+the)?|as|same\s+(?:as|support\s+as|cushioning\s+as|fit\s+as|feel\s+as|style\s+as))\s+(?:the\s+)?([a-z][\w'-]+(?:\s+[a-z][\w'-]+){0,3})/i;

export async function findProductHandleForSimilarAnchor(shop, message, { _testFacts } = {}) {
  if (!shop || !message || typeof message !== "string") return null;
  const text = String(message).trim();
  if (!text) return null;
  const lcText = text.toLowerCase();

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

  // Stage 1: extract anchor phrase, match against titles.
  const m = lcText.match(SIMILAR_ANCHOR_EXTRACT_RE);
  if (m && m[1]) {
    // Tokenize the captured phrase and try its longest meaningful
    // word first (anchors like "the jillian sport sandal" should
    // match before "the").
    const phraseTokens = m[1]
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t && t.length >= 3 && !SPECIFIC_PRODUCT_STOPWORDS.has(t));
    phraseTokens.sort((a, b) => b.length - a.length);
    for (const tok of phraseTokens) {
      const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      for (const f of facts) {
        if (re.test(String(f.title || ""))) return f.productHandle;
      }
    }
  }

  // Stage 2: any meaningful token in the whole message that appears
  // in a title. Conservative — only fires when stage 1 found
  // nothing.
  const messageTokens = lcText
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t.length >= 4 && !SPECIFIC_PRODUCT_STOPWORDS.has(t))
    .sort((a, b) => b.length - a.length);
  for (const tok of messageTokens) {
    const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    for (const f of facts) {
      if (re.test(String(f.title || ""))) return f.productHandle;
    }
  }
  return null;
}
