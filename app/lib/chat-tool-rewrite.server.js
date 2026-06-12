// Pre-dispatch tool-call rewrite pipeline.
//
// "Trust but verify" pattern: production AI agents shouldn't trust the
// LLM with structural signals. The customer's literal latest message is
// the high-confidence input; the AI's tool-call construction is a low-
// confidence intermediate. When the two disagree, the customer wins.
//
// Each rewrite below is a pure function:
//   (toolCall, ctx) → toolCall
// Falls through (returns input unchanged) when the rewrite doesn't
// apply. Composable in a chain.
//
// Vocabulary is data-driven from merchant config — no hardcoded
// category lists, color lists, or SKU patterns specific to any
// merchant. Color enumeration (loadMerchantColors) reads Prisma so it
// stays in chat.jsx; this module receives ctx._merchantColors as
// input. That keeps this module dependency-free and unit-testable.

// Negation detection lives in chat-helpers.server.js so gender detection
// and color injection share the same logic. Re-exported here so existing
// imports (eval harness, future modules) keep working from this module.
import { isPrecededByNegation } from "./chat-helpers.server.js";
export { isPrecededByNegation };

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;
export function escapeRe(s) {
  return String(s).replace(RE_ESCAPE, "\\$&");
}

// Structural — works for any merchant whose SKUs have 1-2 letters then
// 3-5 digits with an optional trailing letter. Examples: L700, L700M,
// AB1234, T9999W. Not catalog-specific.
export const SKU_PATTERN = /\b[A-Z]{1,2}\d{3,5}[A-Z]?\b/g;

// ── stripStaleCategoriesOnScopeReset ─────────────────────────────────
// When the customer's latest message is genuinely open-ended
// ("anything", "everything", "what else", "show me all"), the AI
// sometimes carries a category from the prior turn into its search
// query. Strip category words that ARE in the AI's query but NOT in
// the customer's literal latest message. Vocabulary comes from the
// merchant's own categoryGroups.
//
// Deliberately do NOT treat "any <attribute> ones?" as a reset:
// "women's sandals" → "any pink ones?" means same category, new color.
const SCOPE_RESET_RE = /\b(?:show\s+me\s+(?:anything|everything|whatever)\b|show\s+me\s+all(?:\s+(?:styles|options))?\s*[?.!]*$|anything|everything|all\s+(?:of\s+)?your\b|whatever|all\s+styles|what\s+else|something\s+else|other\s+(?:options|things|stuff))\b/i;

function isBroadScopeResetText(text) {
  return SCOPE_RESET_RE.test(String(text || ""));
}

export function stripStaleCategoriesOnScopeReset(toolCall, ctx) {
  if (toolCall.name !== "search_products") return toolCall;
  const latest = String(ctx.latestUserMessage || "").trim();
  if (!latest) return toolCall;
  if (!SCOPE_RESET_RE.test(latest)) return toolCall;

  const groups = Array.isArray(ctx.merchantGroups) ? ctx.merchantGroups : [];
  const categoryTokens = new Set();
  for (const g of groups) {
    for (const c of (g?.categories || [])) {
      const norm = String(c || "").trim().toLowerCase();
      if (!norm) continue;
      categoryTokens.add(norm);
      for (const tok of norm.split(/\s+/)) {
        if (tok.length >= 4) categoryTokens.add(tok);
      }
    }
  }
  if (categoryTokens.size === 0) return toolCall;

  const query = String(toolCall.input?.query || "");
  const userLower = latest.toLowerCase();
  let cleaned = query;
  let filters = toolCall.input?.filters || null;
  let filtersChanged = false;

  for (const token of categoryTokens) {
    const tokenInUser = new RegExp(`\\b${escapeRe(token)}s?\\b`, "i").test(userLower);
    if (tokenInUser) continue;
    const stripRe = new RegExp(`\\b${escapeRe(token)}s?\\b`, "gi");
    cleaned = cleaned.replace(stripRe, " ");
    if (filters && typeof filters.category === "string") {
      const filterCategory = filters.category.toLowerCase().replace(/-/g, " ").trim();
      if (filterCategory === token || filterCategory.split(/\s+/).includes(token)) {
        const { category, ...rest } = filters;
        filters = rest;
        filtersChanged = true;
      }
    }
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if ((cleaned !== query.trim() && cleaned.length > 0) || filtersChanged) {
    console.log(`[chat] scope-reset: stripped stale categories — "${query}" → "${cleaned}"`);
    const nextInput = { ...toolCall.input, query: cleaned || query };
    if (filtersChanged) nextInput.filters = filters;
    return { ...toolCall, input: nextInput };
  }
  return toolCall;
}

// ── relaxCategoryOnNamedProduct ─────────────────────────────────
// When the customer asks for a specific named product ("show me Vania
// in red", "do you have Charli?"), the LLM dutifully passes the
// currently-locked category as a filter. But the named product may
// live in a DIFFERENT category than the conversation has been
// scoped to — e.g., Vania is a SANDAL but the customer was just
// browsing WEDGES HEELS, so the search comes back empty and the
// bot falls back to "Hmm, nothing's quite hitting that combination"
// (production trace 2026-05-13 11:44). The category lock should
// release for named-product lookups; the product name carries its
// own implicit category.
//
// Detection: extract any capitalized non-common-word token from the
// query string AND check it also appears in the customer's literal
// message. That's the named-product signal. Common words (gender
// tokens, category words, color words, anatomy terms) are excluded.
//
// Action: drop the `category` filter. Leave gender + color in place —
// the search's existing filter-wipeout will further relax them if
// needed. Combined with the OOS-phrasing prompt rule, the LLM can
// then say "Vania in red isn't currently in stock — here it is in
// our other colors, or open the product page to sign up for alerts."
const PROPER_NOUN_RE = /\b([A-Z][a-z]{2,})\b/g;
const NAMED_PRODUCT_COMMON_WORDS = new Set([
  "women", "womens", "men", "mens", "kids", "girls", "boys", "child", "youth", "unisex",
  "sandal", "sandals", "sneaker", "sneakers", "heel", "heels", "wedge", "wedges",
  "boot", "boots", "loafer", "loafers", "oxford", "oxfords", "clog", "clogs",
  "slipper", "slippers", "footwear", "shoe", "shoes", "slip", "slipon", "slipons",
  "orthotic", "orthotics", "insole", "insoles", "footbed", "footbeds",
  "red", "blue", "black", "white", "tan", "brown", "navy", "pink", "green", "grey", "gray",
  "show", "find", "see", "have", "any", "the", "this", "that", "those",
  "morton", "neuroma", "plantar", "fasciitis", "bunion", "bunions", "arch",
  "flat", "high", "medium", "low", "ball", "foot", "feet", "metatarsal", "metatarsalgia",
  "comfort", "casual", "dress", "athletic", "walking", "running", "memory", "foam",
  "got", "okay", "sure", "yes", "no", "yeah", "hmm", "let", "looking",
]);

export function relaxCategoryOnNamedProduct(toolCall, ctx) {
  if (toolCall.name !== "search_products") return toolCall;
  const filters = toolCall.input?.filters;
  // Run when a category, gender, OR color filter is set. Category/gender:
  // a stale memory value must not hide a customer-named product ("show me
  // Jillian" with session.gender=men → gender=men returns zero Jillian).
  // Color: a hard color filter erases the named product entirely when it
  // doesn't come in that color. Live trace 2026-06-12: "you don't have
  // tamara in red?" kept color=red, the Tamara (which exists, but not in
  // red) never appeared in any tool result, and the bot answered "we
  // don't carry a Tamara sandal" — a false denial of a real product. The
  // color moves into the QUERY text instead (soft ranking signal), so the
  // named product always surfaces and the model can answer honestly:
  // "the Tamara comes in black and tan — not red. Want these red ones?"
  if (!filters || (!filters.category && !filters.gender && !filters.color && !filters.color_family && !filters.size && !filters.width)) return toolCall;

  const query = String(toolCall.input?.query || "").trim();
  if (!query) return toolCall;
  const latest = String(ctx.latestUserMessage || "").trim();
  if (!latest) return toolCall;

  const queryTokens = new Set();
  let m;
  const re = new RegExp(PROPER_NOUN_RE.source, "g");
  while ((m = re.exec(query)) !== null) {
    queryTokens.add(m[1].toLowerCase());
  }
  if (queryTokens.size === 0) return toolCall;

  const userLower = latest.toLowerCase();
  let namedProduct = null;
  for (const tok of queryTokens) {
    if (NAMED_PRODUCT_COMMON_WORDS.has(tok)) continue;
    if (tok.length < 4) continue;
    if (userLower.includes(tok)) {
      namedProduct = tok;
      break;
    }
  }

  if (!namedProduct) return toolCall;

  const droppedCategory = filters.category;
  const droppedGender = filters.gender;
  const droppedColor = filters.color || filters.color_family;
  // Size/width hard filters have the same erasure failure as color: a
  // named product with no size-9 variant vanishes while OTHER size-9
  // products survive the wipeout-recovery check (filtered.length > 0),
  // so the bot answers about the wrong products. Drop them as filters,
  // keep them as soft query terms, and the model answers honestly
  // ("it comes in 7-10, not 9").
  const droppedSize = filters.size;
  const droppedWidth = filters.width;
  const {
    category: _dropCat,
    gender: _dropGen,
    color: _dropColor,
    color_family: _dropColorFamily,
    size: _dropSize,
    width: _dropWidth,
    ...remainingFilters
  } = filters;
  // Gender: live trace 2026-06-08 — "how many points to buy Jillian for
  // free?" with memory.gender=men returned 0 Jillian + 2 random men's
  // sandals. Customer-named products override stored gender.
  // Color: dropped as a FILTER but preserved as a QUERY term below, so
  // "Tamara in red" still ranks red first when a red Tamara exists, yet
  // the Tamara always appears even when it doesn't.
  const droppedFields = [];
  if (droppedCategory) droppedFields.push(`category="${droppedCategory}"`);
  if (droppedGender) droppedFields.push(`gender="${droppedGender}"`);
  if (droppedColor) droppedFields.push(`color="${droppedColor}"`);
  if (droppedSize) droppedFields.push(`size="${droppedSize}"`);
  if (droppedWidth) droppedFields.push(`width="${droppedWidth}"`);
  console.log(
    `[chat] named-product detected: "${namedProduct}" — dropping ${droppedFields.join(", ")} so search can find it across the catalog`,
  );
  // Keep the customer's color intent alive as a soft signal: append the
  // dropped color to the query text when it isn't already there.
  let nextQuery = query;
  if (droppedColor && !query.toLowerCase().includes(String(droppedColor).toLowerCase())) {
    nextQuery = `${query} ${droppedColor}`.trim();
  }
  if (droppedSize && !nextQuery.toLowerCase().includes(`size ${String(droppedSize).toLowerCase()}`)) {
    nextQuery = `${nextQuery} size ${droppedSize}`.trim();
  }
  if (droppedWidth && !nextQuery.toLowerCase().includes(String(droppedWidth).toLowerCase())) {
    nextQuery = `${nextQuery} ${droppedWidth} width`.trim();
  }
  return {
    ...toolCall,
    input: {
      ...toolCall.input,
      query: nextQuery,
      filters: Object.keys(remainingFilters).length > 0 ? remainingFilters : undefined,
    },
  };
}

// ── forceComparisonLookup ───────────────────────────────────────────
// When the customer's latest message contains 2+ SKU-like tokens AND a
// comparison verb, the AI sometimes combines them into a single
// search_products query and gets 0 results. Rewrite to lookup_sku per
// SKU.
const COMPARISON_VERB_RE = /\b(better|worse|which|compare|vs\.?|versus|difference|between)\b/i;

export function forceComparisonLookup(toolCall, ctx) {
  const latest = String(ctx.latestUserMessage || "");
  if (!latest) return toolCall;
  if (!COMPARISON_VERB_RE.test(latest)) return toolCall;

  const skus = (latest.match(SKU_PATTERN) || []).map((s) => s.toUpperCase());
  if (skus.length < 2) return toolCall;
  const uniqueSkus = Array.from(new Set(skus));
  if (uniqueSkus.length < 2) return toolCall;

  if (toolCall.name === "search_products") {
    console.log(`[chat] comparison-routing: detected ${uniqueSkus.length} SKUs + comparison verb → rewriting search_products to lookup_sku`);
    return { ...toolCall, name: "lookup_sku", input: { skus: uniqueSkus } };
  }
  if (toolCall.name === "lookup_sku") {
    const existing = Array.isArray(toolCall.input?.skus) ? toolCall.input.skus : [];
    const merged = Array.from(new Set([...existing.map((s) => String(s).toUpperCase()), ...uniqueSkus]));
    if (merged.length !== existing.length) {
      console.log(`[chat] comparison-routing: expanded lookup_sku from ${existing.length} → ${merged.length} SKUs`);
      return { ...toolCall, input: { ...toolCall.input, skus: merged } };
    }
  }
  return toolCall;
}

// ── injectStructuredColorFilter ────────────────────────────────────
// When the customer mentions a color value the merchant has actually
// tagged, inject as filters.color so the search runs the structured
// filter (and our existing relaxedFilters mechanism kicks in if no
// exact match exists). Color values come from the merchant's own
// attributesJson (loaded in chat.jsx via loadMerchantColors and
// cached on ctx._merchantColors). No hardcoded color list.
export function injectStructuredColorFilter(toolCall, ctx) {
  if (toolCall.name !== "search_products") return toolCall;
  if (toolCall.input?._suppressColorInjection === true) return toolCall;
  const colors = ctx._merchantColors;
  if (!Array.isArray(colors) || colors.length === 0) return toolCall;
  const existingFilter = toolCall.input?.filters || {};
  if (existingFilter.color || existingFilter.Color) return toolCall;

  const latest = String(ctx.latestUserMessage || "").toLowerCase();
  if (!latest) return toolCall;

  // Longest-match-first so "hunter green" beats "green".
  const sorted = [...colors].sort((a, b) => b.length - a.length);
  for (const color of sorted) {
    const re = new RegExp(`\\b${escapeRe(color)}\\b`, "i");
    const m = re.exec(latest);
    if (!m) continue;
    if (isPrecededByNegation(latest, m.index)) {
      // Customer said "no red" / "forget red" / "anything but red".
      // Skip injection — the affirmative answer is somewhere else
      // in the message OR the customer is explicitly excluding this
      // color. Either way, don't filter ON the negated value.
      console.log(`[chat] color-inject: SKIP — "${color}" appears in negation context`);
      continue;
    }
    console.log(`[chat] color-inject: "${color}" detected in user text → filters.color`);
    return {
      ...toolCall,
      input: {
        ...toolCall.input,
        filters: { ...existingFilter, color },
      },
    };
  }
  return toolCall;
}

// ── injectLockedGender ──────────────────────────────────────────────
// The "ABSOLUTE GENDER LOCK" prompt rule asks the AI to pass
// filters.gender on every search once a gender is established. The AI
// complies most of the time but drifts on long conversations — by turn
// 15+ it sometimes drops the filter or flips it to the other gender.
// Customer then sees men's products after telling us "I'm a woman".
//
// Code-level enforcement: when ctx.sessionGender is set (latest USER
// message has a gender token, or the customer answered the gender
// chip), force-overlay it onto every product-touching tool call. AI
// compliance becomes irrelevant.
//
// We override even when the AI passed a value — the customer's latest
// stated gender always wins over the AI's recollection. The user-only
// detection in detectGenderFromHistory ensures sessionGender already
// reflects the customer's actual latest pivot.
// Resolve a search category to the set of genders the catalog carries
// it in, using the availability map from getCategoryGenderAvailability.
// Map keys are raw catalog category names (lowercased); the AI may pass
// a canonical compound like "wedges-heels" or "slip-ons", so we also
// probe each hyphen/slash/space-separated token. Returns an array of
// genders ("men" | "women" | "unisex") or null when the category can't
// be confidently resolved in the map (caller stays conservative).
export function lookupCategoryGenders(categoryGenderMap, category) {
  if (!categoryGenderMap || !category) return null;
  const norm = String(category).toLowerCase().trim();
  if (!norm) return null;
  const genders = new Set();
  let found = false;
  const consider = (key) => {
    const entry = categoryGenderMap[key];
    if (entry && Array.isArray(entry.genders)) {
      found = true;
      for (const g of entry.genders) genders.add(g);
    }
  };
  // The catalog map keys on the merchant's raw category label
  // ("wedges heels", lowercased), while filters arrive in the
  // canonicalized hyphenated form ("wedges-heels"). Try both
  // shapes plus per-token before giving up. 2026-06-02 prod: the
  // gender-lock guard kept overriding women→men on a wedges-heels
  // search because lookup("wedges-heels") missed the map key
  // "wedges heels".
  consider(norm);
  consider(norm.replace(/-/g, " "));
  consider(norm.replace(/\s+/g, "-"));
  for (const part of norm.split(/[-/\s]+/)) {
    if (part) consider(part);
  }
  return found ? Array.from(genders) : null;
}

export function injectLockedGender(toolCall, ctx) {
  // LLM-owns path: the model's tool args ARE the intent — no
  // stale-history gender overrides. Live trace 2026-06-10 evening:
  // "compare the Chrissy and the Kaylee boots" (both women's) hit a
  // "gender×category mismatch: requested=men" because a "husband"
  // mention from MUCH earlier in the session was still locked in
  // sessionGender and overrode the model's correct search. The
  // prompt's GENDER LOCK rule already instructs the model to carry
  // gender in filters itself; the Established Answers block gives it
  // the session gender to carry.
  {
    const raw = String(process.env.LLM_OWNS_ALL_TURNS || "").toLowerCase();
    if (raw !== "false") return toolCall;
  }

  const locked = ctx.sessionGender;
  if (!locked) return toolCall;

  if (toolCall.name !== "search_products" && toolCall.name !== "find_similar_products") {
    return toolCall;
  }

  const existingFilters = toolCall.input?.filters || {};
  const aiGender = String(existingFilters.gender || "").toLowerCase().trim();
  const lockedNorm = String(locked).toLowerCase().trim();
  if (aiGender === lockedNorm) return toolCall;

  // If the AI explicitly passed a kids gender, trust it. The session
  // gender detector only knows "men" / "women" and triggers on words
  // like "son" / "daughter" — but those are kids signals, not adult
  // ones. Overriding the AI's "kids" with the stale adult lock from
  // an earlier "for my husband" turn ships men's products to a child.
  const KIDS_TOKENS = new Set(["kids", "kid", "boys", "boy", "girls", "girl", "child", "children"]);
  if (KIDS_TOKENS.has(aiGender)) {
    console.log(`[chat] gender-lock: AI passed kids gender="${aiGender}"; respecting (locked="${lockedNorm}")`);
    return toolCall;
  }

  // Impossible-intersection guard. Forcing the locked gender onto a
  // category the catalog doesn't carry in that gender — while the AI's
  // gender IS carried — guarantees an empty search and a customer-
  // facing "we don't have <lockedGender>" dead-end. Production case:
  // lock stuck on men while the customer pivoted to their mom and the
  // AI (correctly) searched women's heels; the override forced men's
  // heels, which don't exist, so the bot denied stock. When we can
  // POSITIVELY confirm the locked gender is excluded from this
  // category and the AI's gender is included, the lock is wrong for
  // this query — trust the AI. Conservative everywhere else.
  if (aiGender && aiGender !== lockedNorm && ctx.categoryGenderMap) {
    const cat = readConstraintValue(existingFilters.category);
    const avail = lookupCategoryGenders(ctx.categoryGenderMap, cat);
    if (
      avail &&
      avail.length > 0 &&
      !avail.includes("unisex") &&
      !avail.includes(lockedNorm) &&
      avail.includes(aiGender)
    ) {
      console.log(
        `[chat] gender-lock: NOT overriding — locked="${lockedNorm}" doesn't carry ` +
          `category="${cat}" (carried by ${avail.join("/")}); trusting AI gender="${aiGender}"`,
      );
      return toolCall;
    }
  }

  if (aiGender && aiGender !== lockedNorm) {
    console.log(`[chat] gender-lock: AI passed gender="${aiGender}" but customer is "${lockedNorm}" — overriding`);
  } else {
    console.log(`[chat] gender-lock: injecting gender="${lockedNorm}" into ${toolCall.name}`);
  }

  return {
    ...toolCall,
    input: {
      ...toolCall.input,
      filters: { ...existingFilters, gender: lockedNorm },
    },
  };
}

// ── injectLockedCategory ────────────────────────────────────────────
// Same-family follow-ups like "any pink ones?" or "what about wide?"
// should carry the already-established category into the search tool.
// The LLM often sends only the new attribute ("pink"), which lets
// semantic search return pink products from sibling categories. Code
// owns this scope invariant: established category stays locked until
// the customer explicitly resets/widens, names a different category,
// or asks for a specific product.
function readConstraintValue(v) {
  if (v == null) return null;
  if (typeof v === "object" && v.value != null) return v.value;
  return v;
}

function getLockedCategory(ctx) {
  const explicit = readConstraintValue(ctx?.sessionMemory?.explicit?.category);
  if (explicit) return explicit;
  const matched = readConstraintValue(ctx?.resolverState?.matched_constraints?.category);
  if (matched) return matched;
  const inferred = readConstraintValue(ctx?.resolverState?.inferred_constraints?.category);
  if (inferred) return inferred;
  return null;
}

export function injectLockedCategory(toolCall, ctx) {
  if (toolCall.name !== "search_products") return toolCall;

  // LLM-owns path: the model's tool args ARE the intent — never
  // inject a stale memory category behind its back. Live trace
  // 2026-06-10: customer asked "what's BioRocker?" right after a
  // Reagan boot question; this injector stuffed category="boots"
  // into the model's clean search("BioRocker") call → 0 results →
  // the model honestly-but-wrongly told the customer "BioRocker
  // doesn't appear in any of our descriptions". BioRocker lives in
  // sandals/sneakers — excluded by the injected boots filter.
  // When the model WANTS a category lock it passes filters.category
  // itself (the prompt's CATEGORY LOCK rule instructs exactly that).
  {
    const raw = String(process.env.LLM_OWNS_ALL_TURNS || "").toLowerCase();
    if (raw !== "false") return toolCall;
  }

  const existingFilters = toolCall.input?.filters || {};
  if (existingFilters.category || existingFilters.Category) return toolCall;

  const locked = getLockedCategory(ctx);
  if (!locked) return toolCall;

  const latest = String(ctx?.latestUserMessage || "");
  if (isBroadScopeResetText(latest)) return toolCall;

  // If the customer named a specific product/SKU, product identity
  // should drive the search. Category filters can hide the product if
  // it lives outside the current browsing category.
  if (ctx?.sessionMemory?.explicit?.specificProduct || /\b[A-Z]{1,2}\d{3,5}[A-Z]?\b/.test(latest.toUpperCase())) {
    return toolCall;
  }

  const category = String(locked).toLowerCase().trim();
  if (!category) return toolCall;

  console.log(`[chat] category-lock: injecting category="${category}" into search_products`);
  return {
    ...toolCall,
    input: {
      ...toolCall.input,
      filters: { ...existingFilters, category },
    },
  };
}

// ── injectOccasionCategory ──────────────────────────────────────────
// Semantic search returns embedding-similar products regardless of
// physical fit — slippers and walking shoes both score high on
// "comfort" / "support" / "cushioning". A slipper is the wrong product
// for an Italy walking trip even if descriptively similar.
//
// When the customer mentions an occasion that physically constrains
// footwear type (extended walking, marathon, wedding, beach, etc.) AND
// the AI didn't pick a category in its tool call, inject a category
// from the merchant's actual catalog using generic occasion-to-
// category-name patterns.
//
// Generic on both sides:
//   - Occasion regex: standard English phrases (trip/vacation/walking/
//     marathon/wedding/etc.). Works for any vertical.
//   - Category regex: standard fashion taxonomy keywords (sneaker/
//     athletic/heel/sandal/loafer/slipper). Matches against the
//     merchant's catalogCategories — never injects a category the
//     merchant doesn't have.
//
// Skip injection if:
//   - AI already chose a category
//   - Customer's message names a catalog category explicitly
//     ("walking sandals" → customer wants sandals; don't override
//     to sneakers)
const OCCASION_TO_CATEGORY_PATTERNS = [
  {
    name: "walking-active",
    occasionRe: /\b(trip|vacation|sightseeing|walking|on (?:my|your|our) feet|all day|hiking|exploring|tourist|tourism|disney|europe|italy|france|spain|cobblestone|cruise|amusement|standing all day|long walks?|busy day|on the go)\b/i,
    categoryRe: /sneaker|walking|athletic|sport|running|trainer/i,
  },
  {
    name: "running",
    occasionRe: /\b(running|jog|jogging|marathon|sprint|track|gym|workout|crossfit|hiit|fitness|treadmill)\b/i,
    categoryRe: /running|athletic|sneaker|trainer|sport/i,
  },
  {
    name: "indoor",
    occasionRe: /\b(bedtime|lounging|around the house|at home|cozy|nap|bedroom|relaxing|pajamas|movie night|indoors)\b/i,
    categoryRe: /slipper/i,
  },
  {
    name: "beach-pool",
    occasionRe: /\b(beach|pool|swimming|swim|water park|lake|ocean|sand|tropical|cabana)\b/i,
    categoryRe: /sandal|slide|flip[- ]?flop/i,
  },
  {
    name: "formal-dressy",
    occasionRe: /\b(wedding|formal|dressy|gala|prom|black[- ]tie|cocktail|reception|special occasion|fancy|evening event)\b/i,
    categoryRe: /heel|oxford|loafer|dress|wedge|pump|stiletto|mary[- ]?jane/i,
  },
  {
    name: "work-office",
    occasionRe: /\b(office|professional|business casual|business meeting|corporate|conference|board meeting|nine[- ]to[- ]five|9[- ]to[- ]5)\b/i,
    categoryRe: /loafer|oxford|dress|flat|heel|pump/i,
  },
];

export function injectOccasionCategory(toolCall, ctx) {
  if (toolCall.name !== "search_products") return toolCall;
  const filters = toolCall.input?.filters || {};
  if (filters.category || filters.Category) return toolCall;

  const latest = String(ctx.latestUserMessage || "");
  if (!latest) return toolCall;

  const cats = Array.isArray(ctx.catalogCategories) ? ctx.catalogCategories : [];
  if (cats.length === 0) return toolCall;

  // If customer explicitly named a catalog category, the AI should
  // honor that — don't override.
  const lower = latest.toLowerCase();
  const customerNamedCategory = cats.some((c) => {
    const norm = String(c || "").toLowerCase().trim();
    if (!norm || norm.length < 3) return false;
    try {
      return new RegExp(`\\b${escapeRe(norm)}s?\\b`, "i").test(lower);
    } catch {
      return false;
    }
  });
  if (customerNamedCategory) return toolCall;

  for (const { name, occasionRe, categoryRe } of OCCASION_TO_CATEGORY_PATTERNS) {
    if (!occasionRe.test(latest)) continue;
    const match = cats.find((c) => categoryRe.test(String(c)));
    if (match) {
      console.log(`[chat] occasion-category: "${name}" detected → filters.category="${match}"`);
      return {
        ...toolCall,
        input: { ...toolCall.input, filters: { ...filters, category: match } },
      };
    }
  }
  return toolCall;
}

// Compose the pipeline. Order matters slightly:
//   1. Comparison routing (might change tool name from search→lookup)
//   2. Scope reset (strips stale category from search query)
//   3. Color injection (adds structured color filter to search)
//   4. Gender lock (force-overlay customer-stated gender)
//   5. Category lock (force-overlay established product type)
//   6. Occasion category (constrain to walking/dressy/etc. when AI
//      didn't pick a category and the occasion implies one)
// ── redirectOrthoticSearchToRecommender ────────────────────────────
// When the LLM calls search_products with an orthotic-shaped query
// AND a recommend_<intent> tool is registered for the shop,
// redirect to the recommender. Customer questions like "can I get
// orthotics separately", "do you have orthotics for sneakers",
// "what insole works for plantar fasciitis" parse as availability
// search to the LLM but should enter the guided recommender flow
// (gate fires, asks shoe type / condition / arch, resolver picks
// one deterministic SKU) rather than dump 6 lookalikes via
// semantic similarity.
//
// Strict matching to avoid false positives:
//   - Customer's latest message OR the LLM's query must contain a
//     standalone orthotic-domain word ("orthotic"/"orthotics"/
//     "insole"/"insoles"/"footbed").
//   - A recommender tree with intent matching one of those words
//     must be enabled on this shop (ctx.recommenderTrees has the
//     loaded list — same source the prompt uses).
// On match: rewrite { name: "recommend_<intent>", input: {} } so
// the gate runs from a clean slate. Original input is discarded;
// the gate's needMoreInfo response will tell the LLM what to
// actually ask.
const ORTHOTIC_DOMAIN_RE = /\b(orthotic|orthotics|insole|insoles|footbed|footbeds)\b/i;
const ORTHOTIC_BROWSE_RE =
  /\b(?:do\s+you\s+have|do\s+you\s+carry|do\s+you\s+sell|carry|sell|show\s+me|browse|available|any|what(?:'s|\s+is)\s+available|looking\s+for)\b/i;
const ORTHOTIC_CLINICAL_RE =
  /\b(?:recommend|best|which|what\s+should|right\s+for|plantar|fasciitis|flat\s+feet?|high\s+arch|low\s+arch|overpronat|supinat|metatarsal|metatarsalgia|neuroma|heel\s+pain|foot\s+pain|ball[-\s]?of[-\s]?foot|arch\s+pain|diabetes|diabetic)\b/i;

export function redirectOrthoticSearchToRecommender(toolCall, ctx) {
  if (toolCall.name !== "search_products") return toolCall;
  const trees = Array.isArray(ctx?.recommenderTrees) ? ctx.recommenderTrees : [];
  if (trees.length === 0) return toolCall;

  // Find a tree whose intent matches the orthotic domain. Aetrex's
  // intent is literally "orthotic" — match the intent name against
  // the orthotic-domain regex so any future merchant with a similar
  // intent (e.g. "insole") still routes correctly.
  const orthoticTree = trees.find((t) =>
    typeof t?.intent === "string" && ORTHOTIC_DOMAIN_RE.test(t.intent),
  );
  if (!orthoticTree) return toolCall;

  // Customer's text OR the LLM's query string must mention an
  // orthotic-domain word. The query is what the LLM thinks the
  // customer wants; the latest message is ground truth. Either
  // hitting the regex is sufficient.
  const latest = String(ctx?.latestUserMessage || "");
  const queryStr = String(toolCall?.input?.query || "");
  const matchesDomain = ORTHOTIC_DOMAIN_RE.test(latest) || ORTHOTIC_DOMAIN_RE.test(queryStr);
  if (!matchesDomain) return toolCall;

  // Classifier-aware veto. If the upstream Haiku classifier judged
  // the latest message as NOT a recommendation request (e.g. "what
  // is thinsole?" — informational/definitional), don't redirect to
  // recommend_orthotic. The LLM was right to reach for
  // search_products; let the search find the specific product the
  // customer asked about. Without this, "what are Thinsoles?" gets
  // rewritten into a 5-chip flow.
  if (ctx?.classifiedIntent && ctx.classifiedIntent.isOrthoticRequest === false) {
    console.log(
      `[chat] orthotic-routing: skipped redirect — classifier says ortho=false ` +
        `(latest="${latest.slice(0, 50)}"); letting search_products run.`,
    );
    return toolCall;
  }

  // Informational-question veto. Even if the classifier said
  // ortho=true (or ran fallback regex), explicit informational
  // phrasing — "what is X / explain Y / tell me about Z / how does
  // X work" — means the customer wants to learn, not buy. Search is
  // the right tool; let it run. Catches cases where the classifier
  // misclassified an informational question.
  const INFO_QUESTION_RE = /\b(?:what (?:is|are|does|do|exactly)|what'?s (?:the|a|an|your)|how (?:does|do|is|are)\b[^?!.\n]{0,80}?\b(?:work|made|different)|tell me (?:more )?about|explain (?:how|what|the)|describe (?:the|how|what|your)|details? (?:on|about|of)|info(?:rmation)? (?:on|about)|difference between|made of|specs? (?:on|of|for))\b/i;
  if (
    INFO_QUESTION_RE.test(latest) &&
    (latest.endsWith("?") || /^(?:what|how|tell me|explain|describe)\b/i.test(latest.trim()))
  ) {
    console.log(
      `[chat] orthotic-routing: skipped redirect — latest message is informational/definitional ` +
        `("${latest.slice(0, 60)}"); letting search_products run.`,
    );
    return toolCall;
  }

  // Negation escape hatch: customer said "doesn't like orthotics",
  // "not orthotics", "no orthotics", "without orthotics", "besides
  // orthotics", "other than orthotics". The orthotic-domain word
  // appears, but the customer is REJECTING that domain. Redirecting
  // to recommend_orthotic in this case is the opposite of what the
  // customer wants — they're asking for something OTHER THAN an
  // orthotic. Let search_products run with the AI's actual query
  // (e.g. "accessories gift") so the search finds non-orthotic
  // alternatives.
  const NEGATION_RE = /\b(?:no|not|don'?t|doesn'?t|didn'?t|don't[\s-]?like|doesn't[\s-]?like|without|besides|other[\s-]?than|except|aside[\s-]?from|instead[\s-]?of|rather[\s-]?than|hate|hates|dislike|dislikes|avoid|avoids|skip)\b[^.!?\n]{0,40}\b(?:orthotic|orthotics|insole|insoles|footbed|footbeds|shoes?|footwear|sandals?|sneakers?|boots?|clogs?|loafers?|slippers?|oxfords?|wedges?|heels?|flats?|mules?|mary[\s-]?jane|slip[\s-]?ons?)\b/i;
  if (NEGATION_RE.test(latest)) {
    console.log(
      `[chat] orthotic-routing: skipped redirect — customer's message contains a negation ` +
        `("doesn't like / not / no / without orthotics-or-shoes"). Letting search_products run ` +
        `with the AI's actual query so non-orthotic alternatives surface.`,
    );
    return toolCall;
  }

  // Sandal escape hatch: if the customer is asking for an orthotic
  // FOR sandals, don't redirect — orthotic inserts don't fit open
  // sandals, and the recommender would resolve to a wrong product.
  // Let search_products run instead so the AI can show arch-
  // supportive sandals (the actual answer) or honestly say
  // "orthotics don't fit sandals."
  if (/\bsandals?\b/i.test(latest) || /\bsandals?\b/i.test(queryStr)) {
    console.log(
      `[chat] orthotic-routing: skipped redirect — customer mentioned sandals + orthotic ` +
        `(orthotic inserts don't fit sandals; letting search_products run for honest framing)`,
    );
    return toolCall;
  }

  // Availability/browse questions should stay as catalog search.
  // "Do you have orthotics for kids?" is asking what exists, not asking
  // the decision tree to choose an insole from pain/use-case inputs. The
  // recommender can still own clinical recommendation turns such as
  // "what orthotic is best for plantar fasciitis?"
  if (ORTHOTIC_BROWSE_RE.test(latest) && !ORTHOTIC_CLINICAL_RE.test(latest)) {
    console.log(
      `[chat] orthotic-routing: skipped redirect — orthotic availability/browse turn; ` +
        `letting search_products surface catalog matches.`,
    );
    return toolCall;
  }

  console.log(
    `[chat] orthotic-routing: search_products(query="${queryStr.slice(0, 60)}") on orthotic-domain ` +
      `query → rewriting to recommend_${orthoticTree.intent} (gate will collect attributes)`,
  );
  return { name: `recommend_${orthoticTree.intent}`, input: {}, id: toolCall.id };
}

export function rewriteToolCall(toolCall, ctx) {
  let rewritten = toolCall;
  rewritten = forceComparisonLookup(rewritten, ctx);
  rewritten = redirectOrthoticSearchToRecommender(rewritten, ctx);
  rewritten = stripStaleCategoriesOnScopeReset(rewritten, ctx);
  rewritten = injectStructuredColorFilter(rewritten, ctx);
  rewritten = injectLockedGender(rewritten, ctx);
  rewritten = injectLockedCategory(rewritten, ctx);
  rewritten = injectOccasionCategory(rewritten, ctx);
  // Run named-product relaxation LAST: it drops the category filter
  // for explicit named-product lookups, overriding any category
  // injection (e.g. injectOccasionCategory) that may have added one.
  rewritten = relaxCategoryOnNamedProduct(rewritten, ctx);
  return rewritten;
}
