// Product Turn Engine — canonical pipeline for claim-carrying
// product-shopping turns.
//
// Scope: turns where the customer named a category (or category+claim+gender)
// clearly enough that the engine can author the answer from merchant
// catalog data alone, without an LLM agent loop deciding which
// products to show or which claims to make.
//
// Pipeline:
//   1. resolveTurnScope — latest user message + memory (memory fills
//      blanks only; new explicit signals replace stale ones).
//   2. retrieveCandidates — Shopify/catalog search bounded by scope.
//   3. attachClaimFactsToCandidates — every card carries canonical
//      _claimFacts before display. Cards without facts are dropped
//      with a diagnostic log.
//   4. groupVariants — collapse same-base-style color variants into
//      one product family for compare/select purposes.
//   5. selectByProvenFacts — when a claim was requested (bunions,
//      arch support, water-friendly), prefer products with proof.
//      When no claim was requested, keep the full pool.
//   6. composeAnswer — deterministic seller-spirit copy from
//      verified facts only. No medical/comfort claims invented.
//
// Output:
//   { scope, products, facts, answerText, cta, diagnostics }
//
// Flag PRODUCT_TURN_ENGINE_ENABLED=true gates production use.
// Default OFF — this commit builds the architecture but does not
// change live chat behavior. See README in commit message for the
// enable checklist.

import {
  buildProductClaimFacts,
  attachClaimFactsToCard,
} from "./product-claim-facts.server.js";
import {
  getMerchantClaimConfig,
  resolveColorFamily,
  familiesContainingColor,
} from "./merchant-claim-config.server.js";
import { detectStorefrontSearchModifier } from "./storefront-search-cta.server.js";
import {
  deriveCatalogRequirements,
  filterByCatalogRequirements,
  matchCatalogRequirement,
  normalizeCatalogText,
} from "./catalog-query.server.js";
import {
  compactGroup,
  matchingGroupsForText,
} from "./category-intent.server.js";

// Flag — feature gate for production wiring. Read at engine entry
// so flipping it at runtime (env update) takes effect without a
// process restart in dev.
export function productTurnEngineEnabled() {
  return String(process.env.PRODUCT_TURN_ENGINE_ENABLED || "").toLowerCase() === "true";
}

// Public entry. Returns a structured turn result OR null when the
// engine declines to handle the turn (caller falls back to the
// existing LLM agent path).
//
// Args:
//   ctx                  — { shop, sessionMemory, latestUserMessage, ... }
//   options.searchFn     — async (scope) => productCandidates[] (canonical
//                          product shape). Injected so eval mode can
//                          supply fixtures without a DB / Shopify call.
//   options.similarFn    — async ({handle, refTitle, limit}) =>
//                          { products[], reference, error?, missingAttrs? }.
//                          Injected. In production this MUST wrap the
//                          existing find_similar_products handler so we
//                          reuse the merchant's admin-configured
//                          similarMatchAttributes — no parallel rule set.
//   options.resolveNamedProductFn — async (message) => productHandle | null.
//                          Injected. Wraps catalog-resolver.detectSpecificProduct
//                          so the engine doesn't re-implement named-anchor
//                          matching.
//   options.claimConfig  — pre-resolved merchant claim config. If absent,
//                          loaded via getMerchantClaimConfig(ctx.shop).
//   options.forceEnable  — bypass the env flag (eval mode only).
export async function runProductTurn(ctx = {}, options = {}) {
  const forceEnable = !!options.forceEnable;
  if (!forceEnable && !productTurnEngineEnabled()) {
    return null;
  }
  if (typeof options.searchFn !== "function") {
    return null;
  }

  const claimConfig = options.claimConfig
    || (ctx.shop ? await getMerchantClaimConfig(ctx.shop) : null);

  const diagnostics = { rungs: [], engineEnabled: true, claimConfigLoaded: !!claimConfig };

  // 1. Scope
  const scope = resolveTurnScope({
    latestUserMessage: ctx.latestUserMessage || "",
    messages: ctx.messages || [],
    sessionMemory: ctx.sessionMemory || null,
    resolverState: ctx.resolverState || null,
    classifiedIntent: ctx.classifiedIntent || null,
    claimConfig,
  });
  diagnostics.scope = scope;

  // Phase 2 — named-product / similar-to / same-support-as path.
  // When the turn carries a named-product anchor, route to the
  // similar-product flow which REUSES the existing merchant-
  // configured find_similar_products handler. No parallel rule
  // engine. Skips when the merchant hasn't provided similarFn
  // (older callers / fixture mode without the wrapper).
  const similarIntent = detectSimilarProductIntent(scope, ctx);
  if (similarIntent && typeof options.similarFn === "function" && typeof options.resolveNamedProductFn === "function") {
    diagnostics.rungs.push("entered:similar_product_path");
    return await runSimilarProductTurn({
      ctx, scope, similarIntent, claimConfig, diagnostics,
      similarFn: options.similarFn,
      resolveNamedProductFn: options.resolveNamedProductFn,
    });
  }

  const browseClarification = buildBrowseClarification({ ctx, scope });
  if (browseClarification) {
    diagnostics.rungs.push(`clarifier:${browseClarification.reason}`);
    diagnostics.composer = "browse_clarifier";
    return {
      decline: false,
      scope,
      products: [],
      facts: [],
      answerText: browseClarification.text,
      cta: null,
      followUps: [],
      choices: browseClarification.choices,
      diagnostics,
    };
  }

  if (!engineWantsThisTurn(scope, ctx.resolverState)) {
    diagnostics.rungs.push("declined:scope-too-thin");
    return { decline: true, diagnostics };
  }

  // 2. Retrieve
  let rawCandidates = await options.searchFn(scope);
  diagnostics.rungs.push(`retrieved:${rawCandidates.length}`);

  // 2b. Verify concrete catalog requirements against canonical product
  // evidence. This is vocabulary-agnostic: cork, memory foam, BioRocker,
  // or a merchant-defined attribute all use the same evidence contract.
  // SearchFn performs the same filter at source in production; keeping it
  // here makes resolver candidates and injected test candidates obey it too.
  if (scope.requiredCatalogTerms?.length > 0) {
    const before = rawCandidates.length;
    const requirementResult = filterByCatalogRequirements(
      rawCandidates,
      scope.requiredCatalogTerms,
    );
    rawCandidates = requirementResult.products;
    diagnostics.rungs.push(
      `catalog_requirements:${scope.requiredCatalogTerms.join("+")}=${rawCandidates.length}/${before}`,
    );
  }

  // 3. Attach facts. Cards without _claimFacts after this step are
  // a regression — log and drop.
  //
  // When the caller (chat.jsx dispatcher) already projected each
  // candidate via extractProductCards, _claimFacts is present —
  // skip the re-attach. Otherwise (test fixtures, future callers
  // that pass raw shopify-shape products) spread the candidate
  // first so UI fields survive and layer fact fields on top.
  const cardsWithFacts = [];
  const droppedNoFacts = [];
  for (const cand of rawCandidates) {
    const card = cand?._claimFacts
      ? cand
      : { ...cand, ...attachClaimFactsToCard(cand, { shop: ctx.shop, claimConfig }) };
    if (!card._claimFacts) {
      droppedNoFacts.push(cand?.handle || cand?.title || "?");
      continue;
    }
    cardsWithFacts.push(card);
  }
  if (droppedNoFacts.length > 0) {
    console.warn(
      `[product-turn-engine] dropped ${droppedNoFacts.length} card(s) with no _claimFacts: ` +
        droppedNoFacts.slice(0, 5).join(", "),
    );
    diagnostics.rungs.push(`dropped_no_facts:${droppedNoFacts.length}`);
  }

  // 4. Group variants by base style. Same shoe in different colors
  // collapses to one product family. Original cards stay on the
  // family object for downstream display (we still SHOW each color
  // variant; we just don't COMPARE them as different products).
  const families = groupVariantsByBaseStyle(cardsWithFacts);
  diagnostics.rungs.push(`families:${families.length}`);

  // 5. Selection — prefer families that satisfy the requested claim.
  const { selected, deferred, selectionReason } = selectByProvenFacts({
    families,
    scope,
    claimConfig,
  });
  diagnostics.rungs.push(`selected:${selected.length}/deferred:${deferred.length}`);
  diagnostics.selectionReason = selectionReason;

  // 6. Compose deterministic seller-spirit copy. willHaveCta
  // mirrors the same scope gate that decides whether the
  // dispatcher will emit a storefront-search button — keeps the
  // text accurate ("...then use the View All button" only when
  // a button will actually appear).
  const willHaveCta = !!(scope.category || scope.gender || scope.color || scope.modifier);
  const composed = composeAnswer({
    scope,
    selected,
    deferred,
    selectionReason,
    claimConfig,
    willHaveCta,
  });
  diagnostics.composer = composed.reason;

  // Flatten back to displayable cards (every variant of selected
  // families, in family-order). Deferred cards trail after selected
  // if the engine couldn't satisfy the claim exactly.
  const displayCards = familiesToCards([...selected, ...deferred]);

  // CTA — anchored in the resolved scope (gender + category +
  // optional color/modifier). Engine returns the scope only; the
  // dispatcher composes the URL via buildStorefrontSearchCTA so we
  // reuse the merchant's admin-configured storefrontSearchUrlPattern
  // and ctaOverrides — no parallel URL builder, no Aetrex hardcoding.
  //
  // Phase 4: fire the CTA whenever ANY of gender/category/color/
  // modifier is resolved AND the engine actually produced cards.
  // Live 2026-06-04 failure: customer clicked a "Carly Arch Support
  // Sneaker in other colors?" chip while session memory carried
  // gender=kids from a prior orthotic turn. Engine retrieved 0
  // cards (catalog has no kids' sneakers) but still emitted a
  // "View All Kids' Sneakers" CTA that pointed to an empty
  // storefront page. Suppress the CTA when displayCards.length===0
  // — without products, the link almost always points to a
  // confidently-wrong destination.
  const retrievalCta = (
    (scope.category || scope.gender || scope.color || scope.modifier)
    && displayCards.length > 0
  )
    ? {
        kind: "storefront_search",
        gender: scope.gender || null,
        category: scope.category || null,
        color: scope.color || null,
        modifier: scope.modifier || null,
        scopeSource: "engine_scope",
      }
    : null;

  return {
    decline: false,
    scope,
    products: displayCards,
    facts: displayCards.map((c) => c._claimFacts),
    answerText: composed.text,
    cta: retrievalCta,
    followUps: buildProductTurnFollowUps({ scope, families, selectionReason }),
    diagnostics,
  };
}

// ─── 1. Scope resolution ────────────────────────────────────────
//
// "Latest user message wins. Memory only fills blanks."
// resolveTurnIntent + session-memory already implement the
// pivot/stale logic. The engine's job is to read the cleaned
// memory and surface the scope it'll use for retrieval/selection,
// not to redo that logic.
export function resolveTurnScope({ latestUserMessage, messages = [], sessionMemory, resolverState, classifiedIntent, claimConfig }) {
  const explicit = sessionMemory?.explicit || {};
  const classified = classifiedIntent?.attributes || {};
  const matched = resolverState?.matched_constraints || {};
  const inferred = resolverState?.inferred_constraints || {};
  const inferredValue = (key) => inferred?.[key]?.value || null;
  const scope = {
    rawMessage: String(latestUserMessage || "").trim(),
    gender: explicit.gender || classified.gender || matched.gender || inferredValue("gender"),
    category: explicit.category || classified.category || matched.category || inferredValue("category"),
    color: explicit.color || classified.color || matched.color || inferredValue("color"),
    colorFamily: null,
    condition: explicit.condition || classified.condition || matched.condition || inferredValue("condition"),
    useCase: explicit.useCase || classified.useCase || matched.useCase || inferredValue("useCase"),
    width: explicit.width || matched.width || inferredValue("width"),
    size: explicit.size || matched.size || inferredValue("size"),
    modifier: explicit.modifier || matched.modifier || inferredValue("modifier"),
    badge: explicit.badge || matched.badge || inferredValue("badge"),
    onSale: explicit.onSale === true || matched.onSale === true || inferredValue("onSale") === true,
    requestedClaim: null,
    namedProduct: explicit.specificProduct || matched.specificProduct || inferredValue("specificProduct"),
    requiredCatalogTerms: [],
    catalogQuery: "",
    catalogQueryContinuedFromPrior: false,
  };

  const latestModifier = detectStorefrontSearchModifier(scope.rawMessage);
  if (latestModifier) {
    scope.modifier = latestModifier;
    if (latestModifier === "new") {
      scope.badge = "new";
      scope.onSale = false;
    } else if (latestModifier === "bestseller") {
      scope.badge = "best";
      scope.onSale = false;
    } else if (latestModifier === "sale") {
      scope.onSale = true;
      scope.badge = null;
    }
  }

  // Map condition / use-case mentions into a "requested claim" the
  // selector understands. Per spec: claim semantics come from
  // merchant claim rules; the engine just routes the request.
  if (scope.condition) {
    // Any condition tag is a claim the merchant has structured for.
    scope.requestedClaim = { kind: "condition", tag: scope.condition };
  } else if (/\barch\s+support\b/i.test(scope.rawMessage)) {
    scope.requestedClaim = { kind: "archSupport" };
  } else if (/\bwater[\s-]?friendly\b/i.test(scope.rawMessage)) {
    scope.requestedClaim = { kind: "waterFriendly" };
  } else if (scope.width === "wide" || scope.width === "narrow") {
    // Width compatibility — exclude products the merchant has
    // explicitly marketed for the OPPOSITE width via helps_with.
    // Live trace 2026-06-03: customer asked "Do you have wide
    // width?" and got Miles sneakers, which Aetrex itself tags
    // as helps_with=Narrow Feet. The selector had no way to filter
    // because scope.width was never converted to a requested claim.
    scope.requestedClaim = { kind: "widthCompat", want: scope.width };
  } else if (scope.badge) {
    scope.requestedClaim = { kind: "badge", substring: scope.badge };
  } else if (scope.onSale) {
    scope.requestedClaim = { kind: "onSale" };
  }

  // Color family resolution. "black or neutral" → color=black AND
  // colorFamily=neutral. Retrieval can union the family; selection
  // can prefer the explicit color first.
  if (claimConfig && scope.rawMessage) {
    const lc = scope.rawMessage.toLowerCase();
    for (const fam of claimConfig.colorFamilies || []) {
      if (new RegExp(`\\b${escapeRegex(fam.name)}\\b`, "i").test(lc)) {
        scope.colorFamily = fam.name;
        break;
      }
    }
  }

  const catalogRequirements = deriveCatalogRequirements({
    latestUserMessage: scope.rawMessage,
    messages,
    scope,
    claimConfig,
  });
  scope.requiredCatalogTerms = catalogRequirements.requiredTerms;
  scope.catalogQuery = catalogRequirements.catalogQuery;
  scope.catalogQueryContinuedFromPrior = catalogRequirements.continuedFromPrior;

  return scope;
}

// Compare / similar-to / named-anchor phrasing. When the customer
// says "like the X" / "similar to X" / "same support as X", the
// turn is a named-product lookup — the LLM agent's catalog-resolver
// path handles this in v1 (the engine declines).
const NAMED_PRODUCT_ANCHOR_RE =
  /\b(?:like|same\s+(?:as|support\s+as|cushioning\s+as)|similar\s+to|other(?:\s+shoes)?\s+(?:like|with\s+the\s+same))\s+(?:the\s+)?[A-Za-z][\w'-]{2,}\b/i;

// Compare-shape phrasing ("which of these", "compare the first
// two") — engine declines and the agent path handles the compare.
const COMPARE_SHAPE_RE =
  /\b(?:which\s+of\s+(?:these|those|them)|which\s+(?:is|one\s+is)\s+(?:better|worse|more|best|the\s+most)|compare\s+(?:the\s+)?(?:first|top|two|these)|side[\s-]?by[\s-]?side)\b/i;

function engineWantsThisTurn(scope, resolverState = null) {
  const hasResolverCandidates = resolverHasCandidateRecommendation(resolverState);
  const hasCatalogRequirement = scope.requiredCatalogTerms?.length > 0;
  // V1 gate: handle clear claim-carrying retrieval shapes only.
  // Decline named-product lookups (compare/similar/specific-product)
  // and turns missing both a category and a concrete catalog concept.
  // A verified product concept ("BioRocker", "cork", "memory foam")
  // is sufficient retrieval scope even without a category; keeping those
  // in the engine prevents the fallback agent from confidently describing
  // products after an unverified/empty search.
  if (
    !scope.category
    && !scope.color
    && !scope.colorFamily
    && !scope.badge
    && !scope.onSale
    && !scope.modifier
    && !hasResolverCandidates
    && !hasCatalogRequirement
  ) return false;
  if (scope.namedProduct && !hasResolverCandidates && !hasCatalogRequirement) return false;
  const raw = scope.rawMessage || "";
  if (NAMED_PRODUCT_ANCHOR_RE.test(raw)) return false;
  if (COMPARE_SHAPE_RE.test(raw)) return false;
  // Complex multi-criteria turn — let the LLM agent handle it.
  // The engine is a category + claim filter; it can't synthesize
  // "dressy AND walkable AND restaurant-appropriate". Live trace
  // 2026-06-03 Italy turn: customer asked for ONE pair of shoes
  // that works for sightseeing + dinner at nicer restaurants
  // with flat feet support — the engine reduced it to
  // category=sandals + condition=flat_feet and returned flip-flops
  // because they happened to be tagged for flat feet. Declining
  // lets the LLM read the whole nuanced ask and apply judgement.
  if (isComplexMultiCriteriaTurn(raw)) return false;
  return true;
}

// Detect long, multi-criteria customer questions the engine
// shouldn't try to answer as a category filter. Signals:
//   - long message (compound, multi-sentence) AND
//   - conflicting/competing use-case categories (a "dressy +
//     walking 8 miles" ask requires synthesis, not retrieval)
// Threshold tuned so short focused queries
// ("women's sandals for plantar fasciitis") stay on the engine
// path and only the genuinely nuanced ones fall through.
const DRESSY_USE_RE =
  /\b(?:dress(?:y|ier|ed)?|formal|elegant|sophisticated|fancy|upscale|business[\s-]casual|office|interview|wedding|cocktail|night[\s-]out|restaurant|dinner|date\s+night)\b/i;
const ACTIVE_USE_RE =
  /\b(?:walking|walk(?:ed)?|running|hiking|trail|gym|workout|training|miles?\s+(?:a\s+)?day|cobble(?:stone)?s?|sightsee|touring|tourist|cardio|athletic|sport|standing\s+\d+|on\s+(?:my|your)\s+feet)\b/i;
const COMFORT_USE_RE =
  /\b(?:comfort(?:able)?|all[\s-]day|long\s+(?:hours|shift|day)|stand(?:ing)?\s+(?:all|long|on))\b/i;

function isComplexMultiCriteriaTurn(rawMessage) {
  const msg = String(rawMessage || "");
  if (msg.length < 200) return false;
  const hasDressy = DRESSY_USE_RE.test(msg);
  const hasActive = ACTIVE_USE_RE.test(msg);
  const hasComfort = COMFORT_USE_RE.test(msg);
  // "Dressy" plus an active/walking ask is the canonical conflict:
  // the customer wants a single product that satisfies two
  // ordinarily-opposing use cases. Engine can't reason about that.
  if (hasDressy && hasActive) return true;
  // "Dressy + long day on feet" is the same shape from the other
  // side (the comfort signal is about endurance, not formality).
  if (hasDressy && hasComfort) return true;
  return false;
}

function resolverHasCandidateRecommendation(resolverState) {
  if (!resolverState || resolverState.type !== "resolver_state") return false;
  if (resolverState.recommended_next_action?.type !== "recommend") return false;
  return Array.isArray(resolverState.candidate_products) && resolverState.candidate_products.length > 0;
}

// ─── 3b. Catalog-grounded browse clarification ───────────────────
//
// Broad browse turns ("show me shoes", "I need footwear") need a
// follow-up question, but that question must be grounded in merchant
// configuration and catalog coverage. This keeps the old agent from
// inventing unsupported chips like Kids' shoes or Accessories under a
// shoe-style question.
const BROAD_BROWSE_RE =
  /\b(?:show|find|search|shop|browse|need|want|looking\s+for|recommend|suggest|carry|have)\b/i;

function buildBrowseClarification({ ctx = {}, scope = {} } = {}) {
  if (!isBroadBrowseClarificationCandidate(scope)) return null;

  const groups = merchantBrowseGroups(ctx);
  if (groups.length === 0) return null;

  const group = resolveBrowseClarifierGroup(ctx, scope, groups);
  if (!group) {
    const choices = catalogBackedGroupChoices(ctx, groups);
    if (choices.length < 2) return null;
    return {
      reason: "ask_group",
      text: "Which styles would you like to browse?",
      choices,
    };
  }

  const categoryIsConcrete = scope.category && !categoryNamesGroup(scope.category, group);
  if (categoryIsConcrete) return null;

  const gender = normalizeGender(scope.gender);
  if (!gender) {
    const genderChoices = catalogBackedGenderChoicesForGroup(ctx, group);
    if (genderChoices.length >= 2) {
      return {
        reason: "ask_gender",
        text: "Which styles would you like to browse?",
        choices: genderChoices,
      };
    }
  }

  const categoryChoices = catalogBackedCategoryChoicesForGroup(ctx, group, gender);
  if (categoryChoices.length >= 2) {
    const groupLabel = humanGroupLabel(group);
    return {
      reason: "ask_category",
      text: gender
        ? `What type of ${genderPossessive(gender)} ${groupLabel} are you looking for?`
        : `What type of ${groupLabel} are you looking for?`,
      choices: categoryChoices,
    };
  }

  return null;
}

function isBroadBrowseClarificationCandidate(scope = {}) {
  const raw = String(scope.rawMessage || "").trim();
  if (!raw || !BROAD_BROWSE_RE.test(raw)) return false;
  const vagueNeedNewFootwear =
    /\b(?:need|want|looking\s+for|look\s+for)\b[^.?!]{0,40}\bnew\b[^.?!]{0,40}\b(?:shoes?|footwear)\b/i.test(raw) &&
    !/\b(?:show|browse|shop|what'?s\s+new|new\s+arrivals?|latest)\b/i.test(raw);
  if (
    scope.color ||
    scope.colorFamily ||
    scope.onSale ||
    ((scope.badge || scope.modifier) && !vagueNeedNewFootwear)
  ) return false;
  const ignorableNewBadgeClaim =
    vagueNeedNewFootwear &&
    scope.requestedClaim?.kind === "badge" &&
    String(scope.requestedClaim?.substring || "").toLowerCase() === "new";
  if (scope.namedProduct || (scope.requestedClaim && !ignorableNewBadgeClaim) || scope.requiredCatalogTerms?.length > 0) return false;
  if (isComplexMultiCriteriaTurn(raw)) return false;
  return true;
}

function merchantBrowseGroups(ctx = {}) {
  const groups = Array.isArray(ctx.merchantGroups) ? ctx.merchantGroups : [];
  return groups
    .map((g) => compactGroup(g))
    .filter((g) => g?.name && Array.isArray(g.categories) && g.categories.length > 0);
}

function resolveBrowseClarifierGroup(ctx = {}, scope = {}, groups = []) {
  const raw = stripClarifierNoise(scope.rawMessage || "");
  const latestMatches = matchingGroupsForText(raw, groups, { includeTriggers: true });
  if (latestMatches.length === 1) return latestMatches[0];
  if (latestMatches.length > 1) return null;

  if (scope.category) {
    const categoryKey = normalizeCategoryKey(scope.category);
    const byName = groups.find((g) => categoryNamesGroup(categoryKey, g));
    if (byName) return byName;
  }

  const active = compactGroup(ctx.activeCategoryGroup || ctx.contextCategoryGroup);
  if (active?.name) {
    const match = groups.find((g) => normalizeCategoryKey(g.name) === normalizeCategoryKey(active.name));
    if (match) return match;
  }

  return null;
}

function stripClarifierNoise(text) {
  return String(text || "")
    .replace(/\b(?:men'?s|mens|women'?s|womens|kids?|children'?s|childrens)\b/gi, " ")
    .trim();
}

function categoryNamesGroup(value, group) {
  const key = normalizeCategoryKey(value);
  if (!key || !group) return false;
  if (normalizeCategoryKey(group.name) === key) return true;
  if ((group.triggers || []).some((t) => normalizeCategoryKey(t) === key)) return true;
  return false;
}

function catalogBackedGroupChoices(ctx = {}, groups = []) {
  const out = [];
  for (const group of groups) {
    if (catalogBackedCategoryChoicesForGroup(ctx, group, "").length > 0) {
      out.push(humanGroupLabel(group, { title: true }));
    }
  }
  return uniqueLabels(out);
}

function catalogBackedGenderChoicesForGroup(ctx = {}, group) {
  const order = ["men", "women", "kids"];
  const found = new Set();
  for (const category of group?.categories || []) {
    const availability = lookupCategoryAvailability(ctx, category);
    for (const gender of availability?.genders || []) {
      const normalized = normalizeGender(gender);
      if (normalized && normalized !== "unisex") found.add(normalized);
    }
  }
  return order.filter((g) => found.has(g)).map(genderChoiceLabel);
}

// Compute catalog-grounded category chips for the customer's
// active merchant group, restricted to a specific gender. Used by:
//   1. the engine's browse_clarifier ("what type of women's
//      footwear are you looking for?" → chips)
//   2. the resolver no-match dispatcher (customer pivoted to a
//      gender that doesn't carry the requested category — offer
//      categories that DO exist for that gender in the same group,
//      so the bot acts like a sales associate instead of dead-ending)
//
// activeCategoryGroup comes from chat.jsx ctx; reusing it here keeps
// the chip list grounded in the same merchant configuration both
// owners already trust.
export function buildAlternativeCategoryChoices(ctx = {}, gender = "") {
  const group = ctx?.activeCategoryGroup || ctx?.contextCategoryGroup;
  if (!group?.name || !Array.isArray(group?.categories) || group.categories.length === 0) {
    return [];
  }
  return catalogBackedCategoryChoicesForGroup(ctx, group, gender);
}

function catalogBackedCategoryChoicesForGroup(ctx = {}, group, gender = "") {
  // Two-pass: collect every catalog-backed category, then drop the
  // umbrella only when narrower siblings exist. A category whose
  // name matches its group (e.g. "Footwear" inside the Footwear
  // group) is the catch-all bucket — offering it alongside
  // Sneakers/Sandals/Boots is redundant and reads as a dumb bot
  // loop. But when a group has ONLY the umbrella (Orthotics group
  // = ["Orthotics"]), keeping it is the only way the group can
  // surface at all.
  const groupKey = normalizeCategoryKey(group?.name);
  const backed = [];
  for (const category of group?.categories || []) {
    if (!categoryHasCatalogEvidence(ctx, category, gender)) continue;
    backed.push({ category, isUmbrella: groupKey && normalizeCategoryKey(category) === groupKey });
  }
  const hasNarrower = backed.some((entry) => !entry.isUmbrella);
  const out = backed
    .filter((entry) => !(entry.isUmbrella && hasNarrower))
    .map((entry) => displayCategoryLabel(ctx, entry.category));
  return uniqueLabels(out);
}

function categoryHasCatalogEvidence(ctx = {}, category, gender = "") {
  const key = normalizeCategoryKey(category);
  if (!key) return false;
  const availability = lookupCategoryAvailability(ctx, category);
  const normalizedGender = normalizeGender(gender);
  if (normalizedGender && availability) {
    const genders = new Set((availability.genders || []).map((g) => normalizeGender(g)).filter(Boolean));
    return genders.has(normalizedGender) || genders.has("unisex");
  }
  if (!normalizedGender && availability) return true;

  const scopedCategories = categorySet(ctx.catalogCategories || []);
  if (scopedCategories.size > 0 && scopedCategories.has(key)) return true;
  const fullCategories = categorySet(ctx.fullCatalogCategories || []);
  return fullCategories.has(key);
}

function lookupCategoryAvailability(ctx = {}, category) {
  const key = normalizeCategoryKey(category);
  const map = ctx.categoryGenderMap || {};
  for (const [rawKey, rawValue] of Object.entries(map)) {
    if (normalizeCategoryKey(rawKey) !== key) continue;
    const value = rawValue || {};
    return {
      display: value.display || value.label || category,
      genders: Array.isArray(value.genders) ? value.genders : [],
    };
  }
  return null;
}

function categorySet(values = []) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((v) => normalizeCategoryKey(v))
      .filter(Boolean),
  );
}

function displayCategoryLabel(ctx = {}, category) {
  const availability = lookupCategoryAvailability(ctx, category);
  return titleCaseLabel(availability?.display || category);
}

function humanGroupLabel(group, { title = false } = {}) {
  const label = titleCaseLabel(group?.name || "styles");
  return title ? label : label.toLowerCase();
}

function titleCaseLabel(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function uniqueLabels(labels = []) {
  const seen = new Set();
  const out = [];
  for (const label of labels) {
    const clean = String(label || "").trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function genderChoiceLabel(gender) {
  const normalized = normalizeGender(gender);
  if (normalized === "men") return "Men's";
  if (normalized === "women") return "Women's";
  if (normalized === "kids") return "Kids";
  return titleCaseLabel(normalized);
}

function normalizeCategoryKey(raw) {
  return String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── 4. Variant family grouping ─────────────────────────────────
//
// Same shoe in different colors must collapse into one product
// family for comparison and selection. Family key is:
//   1. merchant productLine attribute (best signal when present)
//   2. canonical first-meaningful-title-token (e.g. "jillian")
// Cards that share a key collapse to one family; the family
// carries every variant card for later display.
export function groupVariantsByBaseStyle(cards = []) {
  const byKey = new Map();
  const orderedKeys = [];
  for (const c of cards) {
    const key = familyKey(c);
    if (!byKey.has(key)) {
      byKey.set(key, { key, primary: c, variants: [c] });
      orderedKeys.push(key);
    } else {
      byKey.get(key).variants.push(c);
    }
  }
  return orderedKeys.map((k) => byKey.get(k));
}

function familyKey(card) {
  // Always prefix with gender so Maui Men's and Maui Women's never
  // collapse into the same family. Live trace 2026-06-03 Italy
  // query: a women's-scope search retrieved Maui Women's Flips
  // (correct), but the family-grouping then expanded the "maui"
  // family to include Maui Men's Flips as a "variant" — and the
  // engine displayed every variant in the family. Result: a men's
  // product surfaced in a women's-only carousel.
  const gender = cardGender(card) || "any";

  // Prefer merchant productLine attribute (canonical, set during
  // catalog sync). Fallback: first meaningful title token before
  // any " - " color suffix.
  const productLine = card?._claimFacts?.productLine?.value
    || card?._productLine
    || null;
  if (productLine) return `${gender}:pl:${String(productLine).toLowerCase().trim()}`;

  const title = String(card?.title || "");
  const beforeDash = title.split(/\s[-–—]\s/)[0];
  const tokens = beforeDash
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const t of tokens) {
    if (t.length >= 4 && !FAMILY_STOPWORDS.has(t)) return `${gender}:t:${t}`;
  }
  return `${gender}:h:${card?.handle || title}`;
}

const FAMILY_STOPWORDS = new Set([
  "the", "and", "with", "for", "from", "shoe", "shoes", "footwear",
  "support", "arch", "insole", "insoles", "orthotic", "orthotics",
  "men", "women", "mens", "womens", "kids", "unisex", "size",
]);

// ─── 5. Selection by proven facts ───────────────────────────────
export function selectByProvenFacts({ families, scope, claimConfig }) {
  if (families.length === 0) {
    return { selected: [], deferred: [], selectionReason: "empty_pool" };
  }
  if (!scope.requestedClaim) {
    return {
      selected: preferExactGenderOverUnisex(families, scope.gender),
      deferred: [],
      selectionReason: "no_claim_requested",
    };
  }

  const supports = (family) => familySupportsClaim(family, scope.requestedClaim, claimConfig);

  const proven = families.filter(supports);
  const partial = families.filter((f) => !supports(f));

  if (proven.length === families.length) {
    return {
      selected: preferExactGenderOverUnisex(proven, scope.gender),
      deferred: [],
      selectionReason: "all_proven",
    };
  }
  if (proven.length > 0) {
    // Within proven, prefer families whose cards are tagged with the
    // exact requested gender over families that are only unisex.
    // Live trace (2026-06-03 kids flat-feet): unisex cleats orthotic
    // (L1220u) ranked into the carousel even though kid-gender
    // orthotics exist — unisex is a fallback fit, not a kid-specific
    // recommendation. Same logic helps women/men queries surface
    // gender-specific cards ahead of unisex catch-alls.
    const provenAfterGender = preferExactGenderOverUnisex(proven, scope.gender);
    // Condition claims (plantar_fasciitis, flat_feet, bunions, etc.)
    // are a real fit criterion — the customer specifically asked for
    // products that address that condition. Mixing unrelated
    // "runner-ups" into the carousel surfaces sport-specific or
    // unrelated SKUs (kids' flat-feet query returned cleats and
    // skate orthotics alongside one tagged-flat-feet match). Drop
    // deferred entirely for condition claims so the carousel is
    // wall-to-wall proven matches.
    if (scope.requestedClaim?.kind === "condition") {
      return { selected: provenAfterGender, deferred: [], selectionReason: "all_proven" };
    }
    // Width-compat is a HARD exclusion too — a sneaker tagged for
    // narrow feet is the wrong recommendation for a wide-width
    // shopper. Same logic as condition: drop deferred so the
    // carousel doesn't include the obvious mismatch.
    if (scope.requestedClaim?.kind === "widthCompat") {
      return { selected: provenAfterGender, deferred: [], selectionReason: "all_proven" };
    }
    return { selected: provenAfterGender, deferred: partial, selectionReason: "proven_preferred" };
  }
  // No proven candidates — engine surfaces all as "closest matches"
  // and the composer phrases honestly. NEVER says "all of these
  // have X" when none do.
  return {
    selected: preferExactGenderOverUnisex(families, scope.gender),
    deferred: [],
    selectionReason: "closest_matches_no_proof",
  };
}

// Drop unisex-only families when at least one family carries the
// exact requested gender on its variants. Unisex is a fit FALLBACK,
// not a specific recommendation — surfacing a unisex catch-all in
// place of (or alongside) the gender-specific product reads as
// imprecise and, in the kids case, mislabels the card outright
// ("kid orthotics" preamble over a "Unisex Cleats" title). When the
// requested gender is itself "unisex" or unset, this is a no-op.
function preferExactGenderOverUnisex(families, wantGender) {
  const want = String(wantGender || "").toLowerCase().trim();
  if (!want || want === "unisex") return families;
  const hasExact = (family) => {
    const cards = Array.isArray(family?.variants) ? family.variants : [];
    return cards.some((c) => {
      const g = cardGender(c);
      if (!g) return false;
      // Exact match on the requested gender. Treat "kids" and "kid"
      // as equivalent, and accept gendered kid sub-buckets (boy/girl).
      if (g === want) return true;
      if (want === "kid" && (g === "kids" || g === "boy" || g === "girl")) return true;
      if (want === "kids" && (g === "kid" || g === "boy" || g === "girl")) return true;
      return false;
    });
  };
  const exact = families.filter(hasExact);
  return exact.length > 0 ? exact : families;
}

// Read a card's gender from the projected _gender field (set by
// extractProductCards in production), falling back to the raw
// `attributes.gender` attribute. Fixture-mode candidates that
// haven't been projected still carry attributes — so the engine
// can rank/label correctly in tests too.
function cardGender(card) {
  const direct = String(card?._gender || "").toLowerCase().trim();
  if (direct) return direct;
  const attrs = card?.attributes || card?._attributes || {};
  for (const k of ["gender", "Gender", "gender_fallback"]) {
    const v = attrs?.[k];
    if (v == null || v === "") continue;
    if (Array.isArray(v)) {
      const first = v.find((x) => x != null && x !== "");
      if (first) return String(first).toLowerCase().trim();
    } else {
      return String(v).toLowerCase().trim();
    }
  }
  return "";
}

function familySupportsClaim(family, claim, claimConfig) {
  const cards = family?.variants || [];
  if (claim.kind === "condition") {
    return cards.some((c) =>
      Array.isArray(c?._conditionTags) && c._conditionTags.includes(claim.tag),
    );
  }
  if (claim.kind === "archSupport") {
    return cards.some((c) => c?._archSupport === true);
  }
  if (claim.kind === "waterFriendly") {
    return cards.some((c) => c?._waterFriendly === true);
  }
  // Width compatibility is an EXCLUSION claim, not an inclusion one.
  // A family "supports" wide width if no variant is explicitly marked
  // for narrow feet (and vice versa). Products with no width signal
  // at all are treated as compatible — we only filter out the ones
  // the merchant has actively tagged for the OPPOSITE width.
  if (claim.kind === "widthCompat") {
    const opposite = claim.want === "wide" ? "narrow_feet" : "wide_feet";
    return cards.every((c) => {
      const tags = Array.isArray(c?._conditionTags) ? c._conditionTags : [];
      return !tags.includes(opposite);
    });
  }
  if (claim.kind === "badge") {
    const want = String(claim.substring || "").toLowerCase();
    return cards.some((c) => String(c?._badge || "").toLowerCase().includes(want));
  }
  if (claim.kind === "onSale") {
    return cards.some((c) => c?._onSale === true);
  }
  return false;
}

// ─── 6. Compose ─────────────────────────────────────────────────
//
// Deterministic seller-spirit copy. Phase 4 polish:
//   - Two sentences max: WHY these match + WHAT to do next.
//   - When a retrieval CTA will fire (scope produces a storefront
//     URL via the dispatcher), mention "the View All button" so
//     the customer knows the chip is there to click. Caller
//     signals this by passing willHaveCta=true.
//   - Composer NEVER says "all of these have X" unless every
//     selected card actually has X. NEVER invents support/comfort/
//     medical claims. Verified-only signals: sale state, adjustable
//     hint, claim coverage. The verifier-side strip is unnecessary
//     for engine output — copy is true by construction.
export function composeAnswer({ scope, selected, deferred, selectionReason, willHaveCta = false }) {
  if (selected.length === 0 && deferred.length === 0) {
    // Kids-no-footwear structural gap: the catalog doesn't carry
    // kid-gender shoes at all (only kids orthotics + accessories).
    // The generic "try a different style or color" is wrong here —
    // no style/color change will surface kids footwear that doesn't
    // exist. Emit an honest message that points to the actual kids
    // coverage we DO offer. Live trace 2026-06-03 19:28:27.
    const wantKid = String(scope?.gender || "").toLowerCase().trim();
    const cat = String(scope?.category || "").toLowerCase().trim();
    if ((wantKid === "kid" || wantKid === "kids") && (cat === "footwear" || cat === "shoes")) {
      return {
        text: `We don't carry kids' shoes — for kids we make orthotics and accessories that fit into shoes your child already owns. Want me to show you the kids' orthotics?`,
        reason: "empty_pool_kids_no_footwear",
        cta: null,
      };
    }
    if (scope?.requiredCatalogTerms?.length > 0) {
      const requirement = scope.requiredCatalogTerms.join(" and ");
      return {
        text: `I couldn't find ${scopeLabel(scope, { fallback: "products" })} that list ${requirement} as a feature. I can help you look at the closest alternatives instead.`,
        reason: "empty_pool_catalog_requirement",
        cta: null,
      };
    }
    return {
      text: `I couldn't find ${scopeLabel(scope, { fallback: "matching styles" })} in what we currently carry. Try a different style or color?`,
      reason: "empty_pool",
      cta: null,
    };
  }

  const allFamilies = [...selected, ...deferred];
  const allCards = familiesToCards(allFamilies);
  const n = allCards.length;
  const familyCount = allFamilies.length;
  // When the displayed cards are all unisex but the customer asked
  // about a specific gender (kid/men/women), "kid orthotics style"
  // reads wrong over a "Unisex Cleats Posted Orthotics" card title.
  // Drop the gender from the label in that case — the card title
  // itself names the gender accurately.
  const label = scopeLabel(
    computeEffectiveLabelScope(scope, allCards),
    { fallback: "styles" },
  );
  const leadFamily = selected[0] || deferred[0] || allFamilies[0];
  const leadCard = leadFamily?.primary || leadFamily?.variants?.[0] || allCards[0];
  const leadTitle = String(leadCard?.title || label).trim();
  const catalogRequirement = customerFacingCatalogRequirement(scope, allCards);
  const catalogDefinition = catalogRequirement
    ? findCatalogDefinition(allCards, scope?.requiredCatalogTerms?.[0])
    : "";
  const leadReason = buildLeadRecommendationReason({
    scope,
    leadCard,
    selectionReason,
  });

  let sentence1;
  if (selectionReason === "closest_matches_no_proof") {
    sentence1 = `These are the closest ${label} matches, but I can't confirm every detail you asked for.`;
  } else if (catalogRequirement && isCatalogDefinitionQuestion(scope?.rawMessage)) {
    sentence1 = catalogDefinition
      ? `${catalogRequirement} is our ${catalogDefinition}. I'd start with ${leadTitle} as one style that uses it.`
      : `${catalogRequirement} is one of the features we use in selected styles. I'd start with ${leadTitle} as one example.`;
  } else if (catalogRequirement) {
    const requirementLabel = scope?.category
      ? `${catalogRequirement} ${scope.category}`
      : `styles with ${catalogRequirement}`;
    sentence1 = `For ${requirementLabel}, I'd start with ${leadTitle}${leadReason ? ` because ${leadReason}` : ""}.`;
  } else {
    sentence1 = `I'd start with ${leadTitle}${leadReason ? ` because ${leadReason}` : ""}.`;
  }

  let sentence2 = "";
  if (familyCount > 1) {
    sentence2 = catalogRequirement && selectionReason !== "closest_matches_no_proof" && deferred.length === 0
      ? "The other cards match that feature too, so compare the styles and choose the one that best fits how you'll wear it."
      : selectionReason === "closest_matches_no_proof" || deferred.length > 0
      ? "Compare the other options too, but check each card's details before choosing."
      : "The other options are good alternatives if you prefer their style, color, or fit.";
  } else if (willHaveCta) {
    sentence2 = "Open the card for the full details, or use View All to keep browsing.";
  }

  const text = `${sentence1} ${sentence2}`.replace(/\s{2,}/g, " ").trim();

  return {
    text,
    reason: `${selectionReason}/n=${n}/families=${familyCount}`,
    cta: null,
  };
}

function buildLeadRecommendationReason({ scope, leadCard, selectionReason }) {
  if (!leadCard || selectionReason === "closest_matches_no_proof") return "";

  const requirement = scope?.requiredCatalogTerms?.find((term) =>
    matchCatalogRequirement(leadCard, term).matched,
  );
  if (requirement) {
    return "it includes the feature you asked about";
  }

  const claim = scope?.requestedClaim;
  if (claim?.kind === "condition") {
    return `it is specifically tagged for ${humanizeCondition(claim.tag)}`;
  }
  if (claim?.kind === "archSupport" && leadCard?._archSupport === true) {
    return "it has the arch support you asked for";
  }
  if (claim?.kind === "waterFriendly" && leadCard?._waterFriendly === true) {
    return "it has the water-friendly design you asked for";
  }
  if (claim?.kind === "badge") {
    return `it is tagged ${claim.substring}`;
  }
  if (claim?.kind === "onSale" && leadCard?._onSale === true) {
    return "it is currently on sale";
  }
  if (claim?.kind === "widthCompat") {
    return "it is not tagged for the opposite width";
  }
  if (scope?.color) {
    return `it matches the ${scope.color} color range you asked for`;
  }
  if (scope?.colorFamily) {
    return `it matches the ${scope.colorFamily} color family you asked for`;
  }
  return "it is the closest match for what you asked";
}

function isCatalogDefinitionQuestion(message) {
  return /^\s*(?:what|which)\s+(?:is|are)\b|^\s*(?:tell\s+me\s+about|explain)\b/i
    .test(String(message || ""));
}

function findCatalogDisplayTerm(cards = [], requirement = "") {
  const tokens = normalizeCatalogText(requirement).split(" ").filter(Boolean);
  if (tokens.length === 0) return "";
  const pattern = new RegExp(
    `(${tokens.map(escapeRegex).join("[^A-Za-z0-9]*")})[™®©℠]?`,
    "i",
  );
  for (const card of cards || []) {
    for (const source of [
      card?.title,
      card?._description,
      card?.description,
      card?._descriptionSnippet,
      card?.descriptionSnippet,
    ]) {
      const match = pattern.exec(String(source || ""));
      if (match?.[1]) return match[1].trim();
    }
  }
  return "";
}

function customerFacingCatalogRequirement(scope = {}, cards = []) {
  const requirement = String(scope?.requiredCatalogTerms?.[0] || "").trim();
  if (!requirement) return "";

  // Prefer the merchant's own product-data casing for branded concepts.
  // A shopper may type "bio rocker", but our descriptions establish the
  // customer-facing name as "BioRocker".
  const catalogDisplay = findCatalogDisplayTerm(cards, requirement);
  if (catalogDisplay) return catalogDisplay;

  // Preserve the customer's own casing when the latest message names the
  // concept directly ("BioRocker" instead of the normalized "bio rocker").
  // This is vocabulary-agnostic and falls back to the canonical term for an
  // anaphoric continuation such as "Which other styles use this technology?"
  const rawWords = String(scope?.rawMessage || "").match(/[A-Za-z0-9][A-Za-z0-9'’™®©℠-]*/g) || [];
  for (let size = Math.min(rawWords.length, 6); size >= 1; size -= 1) {
    for (let start = 0; start + size <= rawWords.length; start += 1) {
      const phrase = rawWords.slice(start, start + size).join(" ");
      if (normalizeCatalogText(phrase) === normalizeCatalogText(requirement)) {
        return phrase.replace(/[™®©℠]/g, "").trim();
      }
    }
  }
  return requirement;
}

function findCatalogDefinition(cards = [], requirement = "") {
  const tokens = normalizeCatalogText(requirement).split(" ").filter(Boolean);
  if (tokens.length === 0) return "";
  const termPattern = new RegExp(
    tokens.map(escapeRegex).join("[^A-Za-z0-9]*"),
    "i",
  );
  const candidates = [];

  for (const card of cards || []) {
    const description = cleanCatalogDescription(
      card?._description || card?.description || card?._descriptionSnippet || card?.descriptionSnippet,
    );
    for (const sentence of description.split(/(?<=[.!?])\s+|\n+/).filter(Boolean)) {
      const match = sentence.match(termPattern);
      if (!match || match.index == null) continue;
      const after = sentence
        .slice(match.index + match[0].length)
        .replace(/^[™®©℠\s:;,()\-–—]+/, "")
        .replace(/\s+/g, " ")
        .trim();
      const words = after.split(/\s+/).filter(Boolean);
      if (words.length < 3 || words.length > 24) continue;

      let score = 0;
      if (/^technology\b/i.test(after)) score += 4;
      if (/\b(?:for|helps?|designed|provides?|delivers?|supports?|allows?|creates?|promotes?|improves?|reduces?)\b/i.test(after)) {
        score += 8;
      }
      if (/\b(?:details|machine washable|upper material|heel height)\b/i.test(after)) score -= 10;
      candidates.push({ text: after.replace(/[.!?]+$/, ""), score });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  const best = candidates[0]?.score > 0 ? candidates[0].text : "";
  return /^[A-Z][a-z]/.test(best) ? `${best[0].toLowerCase()}${best.slice(1)}` : best;
}

function cleanCatalogDescription(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function humanizeCondition(tag) {
  const map = {
    plantar_fasciitis: "plantar fasciitis",
    bunions: "bunions",
    flat_feet: "flat feet",
    high_arch: "high arches",
    metatarsalgia: "ball-of-foot pain",
    mortons_neuroma: "Morton's neuroma",
    diabetic: "diabetic foot care",
    arthritis: "arthritis",
    heel_spur: "heel spurs",
    heel_pain: "heel pain",
  };
  return map[tag] || String(tag || "").replace(/_/g, " ");
}

function scopeLabel(scope, { fallback = "styles" } = {}) {
  const parts = [];
  if (scope.modifier === "new") parts.push("new");
  if (scope.gender) parts.push(genderPossessive(scope.gender));
  if (scope.color) parts.push(scope.color);
  if (scope.category) parts.push(scope.category);
  let label = parts.length ? parts.join(" ") : fallback;
  if (scope.modifier === "sale" || scope.onSale) label = `${label} on sale`;
  if (scope.modifier === "bestseller") label = `${label} best sellers`;
  return label;
}

// Effective scope for label-building. When every displayed card is
// unisex AND the customer asked about a specific gender, drop the
// gender from the label so the composer doesn't say "kid orthotics
// style" over a "Unisex Cleats" card. The card title carries the
// honest gender signal in that case.
function computeEffectiveLabelScope(scope, cards = []) {
  if (!scope?.gender || scope.gender === "unisex") return scope;
  if (!Array.isArray(cards) || cards.length === 0) return scope;
  const allUnisex = cards.every((c) => cardGender(c) === "unisex");
  if (!allUnisex) return scope;
  return { ...scope, gender: null };
}

function genderPossessive(g) {
  if (g === "men") return "men's";
  if (g === "women") return "women's";
  if (g === "kids") return "kids'";
  return g;
}

function familiesToCards(families) {
  const out = [];
  for (const f of families) {
    for (const v of f.variants || []) out.push(v);
  }
  return out;
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Read a single canonical string from any of several attribute
// alias keys. Same logic the chat-tools categoryFromAttrs /
// genderFromAttrs use, lifted so the engine doesn't depend on
// extractProductCards-side projections.
function pickAttr(attrs, aliases) {
  if (!attrs) return null;
  for (const k of aliases) {
    const v = attrs[k];
    if (v == null || v === "") continue;
    if (Array.isArray(v)) {
      const first = v.find((x) => x != null && x !== "");
      if (first) return String(first).toLowerCase().trim();
    } else {
      return String(v).toLowerCase().trim();
    }
  }
  return null;
}

// Build an anchor-scoped CTA from the similar-product result set.
// The first result mirrors the anchor's category + gender because
// find_similar_products already filtered to those — no separate
// anchor lookup needed. Returns null when category or gender
// can't be confidently read; we'd rather omit a CTA than ship one
// rooted in stale memory.
function deriveAnchorCTA(cardsWithFacts, reference = {}) {
  const anchor = cardsWithFacts?.[0];
  if (!anchor) return null;
  const attrs = anchor.attributes || anchor._attributes || {};
  const category = String(reference.category || "").toLowerCase().trim()
    || anchor?._category
    || anchor?._claimFacts?.category?.value
    || pickAttr(attrs, ["category", "Category", "category_for_filter", "subcategory"])
    || (anchor.productType ? String(anchor.productType).toLowerCase().trim() : null);
  const genderRaw = String(reference.gender || "").toLowerCase().trim()
    || anchor?._gender
    || pickAttr(attrs, ["gender", "Gender", "gender_fallback"]);
  // Normalize merchant gender label to "men" / "women" / "kids".
  let gender = null;
  if (genderRaw) {
    if (genderRaw.startsWith("men") || genderRaw.startsWith("male") || genderRaw.startsWith("boy")) gender = "men";
    else if (genderRaw.startsWith("women") || genderRaw.startsWith("female") || genderRaw.startsWith("girl") || genderRaw.startsWith("lad")) gender = "women";
    else if (genderRaw.startsWith("kid") || genderRaw.startsWith("child") || genderRaw.startsWith("youth")) gender = "kids";
    else if (genderRaw === "unisex") gender = "unisex";
  }
  if (!category || !gender) return null;
  // Dispatcher converts to a renderable {type:link,url,label} via
  // buildStorefrontSearchCTA so we reuse the merchant's
  // admin-configured pattern + overrides.
  return {
    kind: "storefront_search",
    scopeSource: "anchor_product",
    category,
    gender,
    color: null,
  };
}

function normalizeEngineProductCard(card) {
  const out = { ...(card || {}) };
  if (!out.price_formatted) {
    if (out.priceRange) {
      out.price_formatted = String(out.priceRange);
    } else if (out.price != null && out.price !== "" && Number.isFinite(Number(out.price))) {
      out.price_formatted = `$${Number(out.price).toFixed(2)}`;
    }
  }

  const attrs = out.attributes || out._attributes || {};
  if (!out._category) {
    out._category =
      pickAttr(attrs, ["category", "Category", "category_for_filter", "subcategory"]) ||
      (out.productType ? String(out.productType).toLowerCase().trim() : "");
  }
  if (!out._gender) {
    out._gender = normalizeGender(
      pickAttr(attrs, ["gender", "Gender", "gender_fallback"]) ||
      out.gender ||
      "",
    );
  }
  return out;
}

function normalizeGender(raw) {
  const value = String(raw || "").toLowerCase().trim();
  if (!value) return "";
  if (value.startsWith("men") || value.startsWith("male") || value.startsWith("boy")) return "men";
  if (value.startsWith("women") || value.startsWith("female") || value.startsWith("girl") || value.startsWith("lad")) return "women";
  if (value.startsWith("kid") || value.startsWith("child") || value.startsWith("youth")) return "kids";
  if (value === "unisex") return "unisex";
  return value;
}

// ─── Phase 2: named-product / similar-product path ──────────────
//
// Detects intent shapes like:
//   "similar to Jillian" / "like the Maui" / "same support as Danika"
//   "what other shoes have the same support?" (anchor from sessionMemory)
//
// Does NOT decide similarity — just classifies the turn. The actual
// matching is delegated to the merchant's admin-configured
// find_similar_products handler via options.similarFn.

const SIMILAR_ANCHOR_RE =
  /\b(?:similar\s+to|like(?:\s+the)?|same\s+(?:as|support\s+as|cushioning\s+as|fit\s+as|feel\s+as)|comparable\s+to|other(?:\s+shoes)?\s+(?:like|with\s+the\s+same))\b/i;

const SAME_AS_PRIOR_RE =
  /\bsame\s+(?:support|cushioning|fit|feel|style)\b/i;

// Variant/inventory questions about a named product —
//   "do you have the Jillian in wide width"
//   "what colors does the Andrea come in"
//   "is the Carly available in black"
//   "does the Maui come in size 9"
// These are anchored to a specific product even though the customer
// didn't say "similar to". Routing them through the regular product-
// turn engine produces a generic category carousel that doesn't
// answer the variant question. Routing through the similar-product
// path uses the anchor + merchant similarMatchAttributes (e.g.
// footbed) so the carousel surfaces close styles when the exact
// variant isn't carried.
const NAMED_PRODUCT_VARIANT_QUESTION_RE =
  /\b(?:do\s+you\s+(?:have|carry|stock|sell)|is\s+(?:the|there)|does\s+the|what\s+(?:colors?|sizes?|widths?)\s+(?:does|do))\b[^?!.]{1,80}\b(?:in\s+(?:wide|narrow|extra[\s-]wide|medium|size|black|white|brown|tan|red|blue|green|yellow|pink|orange|purple|navy|gray|grey|silver|gold|beige|ivory|taupe|cognac|cream|champagne|coral|nude|olive|burgundy|charcoal|teal|mint|sage|rose|blush)|come(?:s)?\s+in|available\s+(?:in|with)|carry\s+(?:it|that|this)|in\s+stock|in\s+(?:my|a)\s+size)\b/i;

// Generic ranking phrasing — used by the composer to decide
// whether to honestly admit "we can't rank exactly" when the
// requested ranking criterion isn't in the merchant's configured
// similarity attributes.
const RANKING_RE =
  /\b(?:most|best|highest|top|maximum|greater?)\s+(\w[\w-]*)\b/i;

export function detectSimilarProductIntent(scope, ctx) {
  const rawMessage = String(scope?.rawMessage || ctx?.latestUserMessage || "");
  if (!rawMessage) return null;

  // Two flavors:
  //  a) The message names an anchor product directly ("similar to
  //     Jillian", "like the Maui"). detectSpecificProduct (the
  //     resolveNamedProductFn injected) will resolve the handle.
  //  b) The message references "the same X" without a fresh anchor
  //     ("what other shoes have the same support?"). The anchor
  //     comes from sessionMemory.explicit.specificProduct or the
  //     last shown product.
  const hasAnchorWord = SIMILAR_ANCHOR_RE.test(rawMessage);
  const hasSameAs = SAME_AS_PRIOR_RE.test(rawMessage);
  // Variant/inventory questions about a named product also count as
  // anchor intent — resolveNamedProductFn will confirm whether a
  // product name is actually present. If it can't resolve, the
  // similar-turn path declines and the engine falls back to the
  // generic search.
  const hasVariantAnchor = NAMED_PRODUCT_VARIANT_QUESTION_RE.test(rawMessage);
  if (!hasAnchorWord && !hasSameAs && !hasVariantAnchor) return null;

  // Ranking criterion (if any) — composer uses this to decide
  // whether to admit "we don't have data to rank exactly."
  const rankMatch = rawMessage.match(RANKING_RE);
  const rankingCriterion = rankMatch ? rankMatch[1].toLowerCase() : null;

  return {
    rawMessage,
    // Treat variant-shaped questions the same as explicit anchor
    // mentions — the resolver will try to find the product name in
    // the message; if it can't, the similar-turn declines cleanly.
    anchorInMessage: hasAnchorWord || hasVariantAnchor,
    rankingCriterion,
    priorAnchorHandle:
      ctx?.sessionMemory?.explicit?.specificProduct || null,
  };
}

async function runSimilarProductTurn({
  ctx, scope, similarIntent, claimConfig, diagnostics,
  similarFn, resolveNamedProductFn,
}) {
  // Resolve the named-product anchor. Try the latest message
  // first; fall back to sessionMemory.specificProduct if the
  // current message uses "same as" referring to a prior turn.
  let anchorHandle = null;
  if (similarIntent.anchorInMessage) {
    try {
      anchorHandle = await resolveNamedProductFn(similarIntent.rawMessage);
    } catch (err) {
      console.warn(`[product-turn-engine] anchor resolve failed: ${err?.message || err}`);
    }
  }
  if (!anchorHandle && similarIntent.priorAnchorHandle) {
    anchorHandle = similarIntent.priorAnchorHandle;
  }
  if (!anchorHandle) {
    diagnostics.rungs.push("similar:declined_no_anchor");
    return { decline: true, diagnostics };
  }
  diagnostics.anchorHandle = anchorHandle;

  // Delegate matching to the existing merchant-configured
  // find_similar_products handler. Engine does not re-implement
  // similarity rules.
  let similarResult;
  try {
    similarResult = await similarFn({
      handle: anchorHandle,
      limit: ctx?.productCardCap || 6,
    });
  } catch (err) {
    console.warn(`[product-turn-engine] similarFn failed: ${err?.message || err}`);
    diagnostics.rungs.push("similar:errored");
    return { decline: true, diagnostics };
  }

  // Configuration-missing surface from find_similar_products:
  //   error="Similar-product matching is not configured…" / "no value
  //   for the configured similarity attribute(s): X". Decline so the
  //   agent path can either admit it or run a different shape.
  if (!similarResult || similarResult.error) {
    diagnostics.rungs.push(`similar:config_or_data_missing:${similarResult?.error?.slice(0, 80) || "unknown"}`);
    return { decline: true, diagnostics };
  }

  const rawCandidates = Array.isArray(similarResult.products) ? similarResult.products : [];
  diagnostics.rungs.push(`similar:retrieved:${rawCandidates.length}`);

  // Fact-attach + base-style group (same as the retrieval path).
  const cardsWithFacts = [];
  for (const cand of rawCandidates) {
    const normalized = normalizeEngineProductCard(cand);
    const card = { ...normalized, ...attachClaimFactsToCard(normalized, { shop: ctx.shop, claimConfig }) };
    if (!card._claimFacts) continue;
    cardsWithFacts.push(card);
  }
  const families = groupVariantsByBaseStyle(cardsWithFacts);
  diagnostics.rungs.push(`similar:families:${families.length}`);

  // Compose. Composer honors the ranking criterion: if the
  // customer asked "which has the most cushioning" and that token
  // isn't in the merchant's configured similarity attributes, we
  // admit the limit instead of inventing a ranking.
  const configuredAttrs = Array.isArray(ctx?.similarMatchAttributes)
    ? ctx.similarMatchAttributes.map((s) => String(s || "").toLowerCase().trim()).filter(Boolean)
    : [];
  const composed = composeSimilarAnswer({
    scope, similarIntent, anchorHandle, anchorTitle: similarResult.reference?.title || anchorHandle,
    families, configuredAttrs,
  });

  const displayCards = familiesToCards(families);

  // CTA derived from the ANCHOR result product, NEVER from stale
  // session memory. Live failure: prior turns set
  // sessionMemory.gender=men, and the auto-search CTA shipped
  // "View All Men's Footwear" on a Danika similar-product result
  // that's women-only. By rooting CTA in the result-set scope (or
  // omitting it when category/gender aren't both confidently
  // known), stale memory can never leak into the link.
  //
  // The result set was filtered by find_similar_products to the
  // anchor's category + gender, so the first similar product's
  // scope mirrors the anchor's scope. Read category/gender out of
  // attributes directly — engine cards don't carry _category /
  // _gender (those are extractProductCards-side fields).
  const cta = deriveAnchorCTA(cardsWithFacts, similarResult.reference);

  return {
    decline: false,
    scope,
    products: displayCards,
    facts: displayCards.map((c) => c._claimFacts),
    answerText: composed.text,
    cta,
    followUps: buildSimilarTurnFollowUps({
      anchorTitle: similarResult.reference?.title || anchorHandle,
      families,
    }),
    diagnostics: { ...diagnostics, composer: composed.reason, ctaSource: cta ? "anchor_product" : "none" },
  };
}

export function composeSimilarAnswer({
  scope, similarIntent, anchorHandle, anchorTitle, families, configuredAttrs,
}) {
  if (families.length === 0) {
    return {
      text: `I couldn't find another style close enough to ${anchorTitle}. Want to widen the search?`,
      reason: "similar_empty",
      cta: null,
    };
  }
  const n = families.length;
  const total = familiesToCards(families).length;

  // Honesty about ranking. If the customer asked "most X" and X
  // isn't a configured similarity attribute (merchant-data-driven,
  // NO hardcoded list of "cushioning"/"support" anywhere), say so.
  let rankingCaveat = "";
  if (similarIntent.rankingCriterion) {
    const c = similarIntent.rankingCriterion;
    const isConfigured = configuredAttrs.some((a) => a.includes(c) || c.includes(a));
    if (!isConfigured) {
      rankingCaveat =
        ` I can't rank these by ${c} specifically, but they share ${anchorTitle}'s` +
        (configuredAttrs.length > 0 ? ` ${configuredAttrs.join(", ")}` : " key features") +
        ` plus category and gender.`;
    }
  }

  const lead = n === 1
    ? `I found one style similar to ${anchorTitle}.`
    : `I found ${n} styles similar to ${anchorTitle}.`;

  const why = configuredAttrs.length > 0 && !rankingCaveat
    ? ` They share the same ${configuredAttrs.join(", ")} plus category and gender, and I left out other colors of the ${anchorTitle} family.`
    : (rankingCaveat ? "" : ` They share the same category and gender as ${anchorTitle}.`);

  // "Tap a card" boilerplate removed (customer feedback 2026-06-03):
  // the cards are visible, telling them what to do with them just
  // adds length. Lead + why is the whole answer.
  const text = `${lead}${rankingCaveat || why}`.replace(/\s{2,}/g, " ").trim();
  return { text, reason: rankingCaveat ? "similar_ranking_caveat" : "similar_matched", cta: null };
}

// Phase 4 follow-up chips for product retrieval turns.
//
// Each chip must read as a question a CUSTOMER would actually type
// — never a UI instruction ("Filter by color" is wrong: a customer
// would say "What other colors are available?"). Live 2026-06-04
// audit: "Filter by color" / "Filter by size" / "Show on-sale
// styles only" are widget directives, not customer language;
// rewritten to natural questions.
//
// Deterministic, merchant-data-aware. We only emit chips the bot
// can ACTUALLY answer:
//   - Color refinement is safe (chat path supports it).
//   - "Compare the top two" hits the existing compare-shape detector.
//   - Width/size questions hit the existing facet handlers.
//   - "Anything on sale?" hits the search onSale filter.
//
// NEVER suggest a question that would contradict established
// scope (e.g. don't push gender). NEVER reference a claim the bot
// hasn't verified.
export function buildProductTurnFollowUps({ scope, families, selectionReason } = {}) {
  if (!Array.isArray(families) || families.length === 0) return [];
  const out = [];

  // Compare lives at every multi-style turn — the compare path is
  // already an established engine intent shape. Phrased the way a
  // customer would say it.
  if (families.length >= 2) {
    out.push(`Compare the top two`);
  }

  // Color refinement. Phrased as the actual question a customer
  // would type, not a widget instruction.
  if (scope.color) {
    out.push(`What other colors are available?`);
  } else {
    out.push(`What colors are available?`);
  }

  // Width is a universal sizing question. Direct yes/no shape.
  out.push(`Do you have wide width?`);

  // Sale filter — customer-natural phrasing.
  out.push(`Anything on sale?`);

  // Drill into the most popular when the catalog is broad.
  if (families.length >= 3) {
    out.push(`What's the most popular?`);
  }

  // Cap at 3 — widget UX. Drop the lowest-priority overflow.
  return out.slice(0, 3);
}

// Phase 4 follow-up chips for similar-product turns. Anchored on
// the named-product intent so the customer can drill into the
// anchor or pivot to color/size — phrased as customer questions.
export function buildSimilarTurnFollowUps({ anchorTitle, families } = {}) {
  const out = [];
  if (Array.isArray(families) && families.length >= 2) {
    out.push(`Compare the top two`);
  }
  if (anchorTitle) {
    const anchor = truncateAnchorLabel(anchorTitle);
    out.push(`What colors does the ${anchor} come in?`);
  }
  out.push(`What sizes are available?`);
  out.push(`Do you have wide width?`);
  return out.slice(0, 3);
}

function truncateAnchorLabel(title) {
  // First meaningful word — typically the family name. "Jillian
  // Sport Sandal" → "Jillian".
  const m = String(title || "").match(/^([A-Z][\w'-]+)/);
  return m ? m[1] : "this style";
}

// Exported for tests + the offline transcript harness.
export const __internals = {
  engineWantsThisTurn,
  familyKey,
  familySupportsClaim,
  scopeLabel,
  detectSimilarProductIntent,
  composeSimilarAnswer,
  buildProductTurnFollowUps,
  buildSimilarTurnFollowUps,
  SIMILAR_ANCHOR_RE,
  SAME_AS_PRIOR_RE,
  RANKING_RE,
  NAMED_PRODUCT_VARIANT_QUESTION_RE,
};
