import { normalizeCategory, normalizeColor } from "./catalog-facts.server.js";
import {
  canonicalizeCatalogConstraints,
  catalogScopedNavigationQuestionVerdict,
} from "./catalog-matcher.server.js";

function normalize(s) {
  return String(s || "").trim().toLowerCase().replace(/s$/, "");
}

function chipTokens(inner) {
  const whole = normalize(inner);
  const tokens = new Set();
  if (whole) tokens.add(whole);
  for (const w of String(inner || "").toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    const n = w.replace(/s$/, "");
    if (n) tokens.add(n);
  }
  return tokens;
}

// "What type/kind/style of shoes/footwear" generic detector. Used to
// decide whether the chip allow-list should be NARROWED to a single
// merchant-configured group (e.g. Footwear) before the broader
// filterForbiddenCategoryChips strip. Pure English — no shop-
// specific category names anywhere in the regex.
//
// 2026-06-03 live failure: men's catalog includes Accessories +
// Orthotics + Footwear sub-categories. When the AI asked "What
// type of men's shoes are you looking for?" it offered
// <<Accessories>>, <<Orthotics>> chips alongside <<Sneakers>>,
// <<Sandals>>, <<Clogs>>. filterForbiddenCategoryChips treats
// Accessories / Orthotics as in-catalog (true) and lets them
// survive. Narrowing the allow-list to the Footwear group's
// categories first fixes the leak.
// Allow up to 2 intervening words between "of" and the shoe noun
// so phrasings like "what type of men's shoes" / "what kind of
// your favorite footwear" / "what style of women's casual shoes"
// still match. Anchor on the question-word and the noun.
const SHOE_QUESTION_RE =
  /\b(?:what|which)\s+(?:type|kind|sort|style|category)\s+of\s+(?:[\w'-]+\s+){0,3}(?:shoes?|footwear)\b|\bwhat\s+(?:[\w'-]+\s+){0,2}(?:shoes?|footwear)\b|\bwhich\s+(?:[\w'-]+\s+){0,2}(?:shoes?|footwear)\b/i;

export function looksLikeShoeTypeQuestion(text) {
  return SHOE_QUESTION_RE.test(String(text || ""));
}

// Narrow the chip allow-list to a single merchant-configured group's
// categories when the assistant's question scope warrants it.
//
// Inputs:
//   text          — assistant text (chip question).
//   currentAllow  — current allow-list (e.g. ctx.catalogCategories,
//                   gender-scoped).
//   merchantGroups — array of {name, categories[]} from
//                    ctx.merchantGroups.
//   groupName     — which group to narrow to (default "Footwear").
//
// Behavior:
//   - When `looksLikeShoeTypeQuestion(text)` is true AND the group
//     exists AND the group has categories AND it intersects with
//     currentAllow, return the intersection.
//   - Otherwise return currentAllow unchanged.
//
// Pure data: caller supplies the group name and merchant-uploaded
// categories. No hardcoded "Sneakers/Sandals/Clogs" list anywhere.
export function narrowChipAllowListForGroup(text, currentAllow, merchantGroups, groupName = "Footwear") {
  if (!looksLikeShoeTypeQuestion(text)) return currentAllow;
  if (!Array.isArray(merchantGroups) || merchantGroups.length === 0) return currentAllow;
  const target = merchantGroups.find((g) => String(g?.name || "").toLowerCase() === String(groupName).toLowerCase());
  if (!target || !Array.isArray(target.categories) || target.categories.length === 0) return currentAllow;

  const allowSet = new Set((currentAllow || []).map(normalize).filter(Boolean));
  const groupSet = new Set(target.categories.map(normalize).filter(Boolean));
  // Intersection: keep only categories that are BOTH in the gender-
  // scoped allow AND in the group's categories.
  const narrowed = (currentAllow || []).filter((c) => groupSet.has(normalize(c)));
  if (narrowed.length === 0) {
    // Group has no overlap with current allow (e.g. shop with zero
    // footwear). Return original allow — better than emitting no
    // chips at all.
    return currentAllow;
  }
  // Sanity check the intersection actually narrowed something —
  // otherwise no-op (avoids spurious logging upstream).
  if (narrowed.length === allowSet.size) return currentAllow;
  return narrowed;
}

// A chip is considered a "category chip" only if one of its tokens matches
// a category that exists somewhere in THIS shop's catalog (fullKnownCategories).
// This is fully data-driven — no hardcoded shoe/footwear vocabulary. Works for
// any store: a jewelry store's categories populate fullKnownCategories, a
// clothing store's do the same, etc.
//
// Rule: strip a chip if any of its tokens matches a known catalog category
// that is NOT in the current gender-scoped allow-list. Example: if the shop
// has women's boots but no men's boots, "boot" is in fullKnownCategories
// (because women's boots exist) but not in the men's allow-list — so
// <<Boots>> gets stripped when the customer asked for men's shoes.
//
// `extraAllowCategories` extends the allow-list. Used when the active
// category group declares a containment relationship via `goesInsideOf`
// (e.g. Orthotics goesInside Footwear, Cases goesInside Phones, Lenses
// goesInside Cameras). In that flow the AI naturally generates chips for
// the CONTAINER's categories (the "what shoes will the orthotic go inside?"
// question), and stripping those would damage the assistant text the
// downstream intent analyzer relies on. Pure data — pulled from the
// merchant's group config, no hardcoded vocabulary.
export function filterForbiddenCategoryChips(
  text,
  catalogCategories,
  fullKnownCategories,
  extraAllowCategories,
) {
  if (!text || typeof text !== "string") return { text: text || "", stripped: [] };

  const allow = new Set((catalogCategories || []).map(normalize).filter(Boolean));
  for (const c of extraAllowCategories || []) {
    const n = normalize(c);
    if (n) allow.add(n);
  }
  const known = new Set(((fullKnownCategories && fullKnownCategories.length > 0) ? fullKnownCategories : catalogCategories || []).map(normalize).filter(Boolean));
  const stripped = [];

  const out = text.replace(/<<([^<>|]+)>>/g, (match, inner) => {
    const tokens = chipTokens(inner);
    if (tokens.size === 0) return match;

    let hasForbiddenCategory = false;
    let hasAnyCategoryToken = false;

    for (const t of tokens) {
      if (known.has(t)) {
        hasAnyCategoryToken = true;
        if (allow.has(t)) continue;
        hasForbiddenCategory = true;
      }
    }

    if (!hasAnyCategoryToken) return match;
    if (hasForbiddenCategory) {
      stripped.push(inner.trim());
      return "";
    }
    return match;
  });

  return {
    text: out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
    stripped,
  };
}

// Strip gender chips that contradict the catalog given the user's
// mentioned categories. Example:
//   User said "boots" → only women's boots stocked → strip <<Men's>> chip
//
// Pure data, no hardcoded shoe vocabulary. Catalog drives both the
// category recognition (categoryGenderMap keys) and the gender split.
//
// Decision rule for each gender chip in the AI's reply:
//   1. Detect categories the user has mentioned in the conversation
//      (whole-word match against keys of categoryGenderMap).
//   2. If the user mentioned NO categories → keep the chip (no signal).
//   3. For each mentioned category, check its gender set:
//      - If the chip's gender (or "unisex") appears → that category
//        supports this chip → keep it.
//      - If NO mentioned category supports this chip's gender → strip.
//
// Unisex categories support both men's and women's chips (because
// unisex products work for either request).

const GENDER_CHIP_TOKENS = {
  men: ["men", "mens", "men's", "male", "boy", "boys", "boy's", "guys"],
  women: ["women", "womens", "women's", "female", "girl", "girls", "girl's", "ladies"],
  kids: ["kid", "kids", "kid's", "child", "children", "youth"],
};

function chipGender(inner) {
  const norm = String(inner || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  if (norm.some((t) => GENDER_CHIP_TOKENS.men.includes(t))) return "men";
  if (norm.some((t) => GENDER_CHIP_TOKENS.women.includes(t))) return "women";
  if (norm.some((t) => GENDER_CHIP_TOKENS.kids.includes(t))) return "kids";
  return null;
}

function detectCategoriesInText(text, categoryKeys) {
  if (!text || !categoryKeys || categoryKeys.length === 0) return [];
  const lower = String(text).toLowerCase();
  const found = new Set();
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const k of categoryKeys) {
    // 1. Try the whole multi-word key first ("wedges heels").
    const fullRe = new RegExp(`\\b${escapeRe(k)}(?:s|es)?\\b`, "i");
    if (fullRe.test(lower)) {
      found.add(k);
      continue;
    }
    // 2. For multi-word keys, try each significant word (>=4 chars) so
    //    "wedges" alone matches the "wedges heels" key. Single-word keys
    //    skip this loop because step 1 already covered them.
    const words = k.split(/\s+/).filter((w) => w.length >= 4);
    if (words.length <= 1) continue;
    for (const w of words) {
      const re = new RegExp(`\\b${escapeRe(w)}(?:s|es)?\\b`, "i");
      if (re.test(lower)) {
        found.add(k);
        break;
      }
    }
  }
  return Array.from(found);
}

export function filterContradictingGenderChips(text, conversationText, categoryGenderMap) {
  if (!text || typeof text !== "string") return { text: text || "", stripped: [] };
  if (!categoryGenderMap || typeof categoryGenderMap !== "object") return { text, stripped: [] };
  const keys = Object.keys(categoryGenderMap);
  if (keys.length === 0) return { text, stripped: [] };

  const mentioned = detectCategoriesInText(conversationText || "", keys);
  if (mentioned.length === 0) return { text, stripped: [] };

  // Genders that ANY mentioned category supports.
  const supportedGenders = new Set();
  for (const cat of mentioned) {
    const entry = categoryGenderMap[cat];
    if (!entry?.genders) continue;
    for (const g of entry.genders) supportedGenders.add(g);
  }
  // Unisex products satisfy both men's and women's queries.
  if (supportedGenders.has("unisex")) {
    supportedGenders.add("men");
    supportedGenders.add("women");
  }

  const stripped = [];
  const out = text.replace(/<<([^<>|]+)>>/g, (match, inner) => {
    const g = chipGender(inner);
    if (!g) return match; // not a gender chip
    if (supportedGenders.has(g)) return match;
    stripped.push(inner.trim());
    return "";
  });

  return {
    text: out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
    stripped,
  };
}

// Context-carrying gender navigation chips. The LLM asks "men's or
// women's?" with bare <<Men's>><<Women's>> chips; when the customer
// already named a category, a tapped bare chip round-trips as a
// context-free "Women's" the engine has to re-anchor. Rewrite ONLY
// bare gender chips (a single gender token — "Men", "Men's",
// "Women", "Women's"; case-insensitive) into the possessive
// compound: <<Men's shoes>> / <<Women's shoes>>. Composed
// server-side from engine data (the caller derives categoryNoun
// from the current catalog scope) — the LLM never invents the
// compound, and the result still flows through
// filterCatalogScopedNavigationChips for catalog validation.
//
// No-ops when categoryNoun is falsy or when a chip is already
// compound (more than the bare gender token). Gender + ONE noun,
// never more.
const BARE_GENDER_CHIP_RE = /^(men|women)(?:['’]s)?$/i;

export function decorateGenderNavigationChips(text, { categoryNoun = "" } = {}) {
  if (!text || typeof text !== "string") return { text: text || "", decorated: [] };
  const noun = String(categoryNoun || "").trim();
  if (!noun) return { text, decorated: [] };

  const decorated = [];
  const out = text.replace(/<<([^<>|]+)>>/g, (match, inner) => {
    const m = String(inner).trim().match(BARE_GENDER_CHIP_RE);
    if (!m) return match; // not a bare gender chip (already compound, or not gender)
    const gender = m[1].toLowerCase() === "men" ? "Men" : "Women";
    const label = `${gender}'s ${noun}`;
    decorated.push(label);
    return `<<${label}>>`;
  });

  return { text: out, decorated };
}

function categoryFromChip(inner, catalogCategories) {
  const text = String(inner || "").toLowerCase().replace(/[_-]+/g, " ");
  const direct = normalizeCategory(inner);
  if (direct) return direct;

  const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const raw of catalogCategories || []) {
    const display = String(raw || "").trim();
    if (!display) continue;
    const phrase = display.toLowerCase().replace(/[_-]+/g, " ");
    const re = new RegExp(`\\b${escapeRe(phrase)}\\b`, "i");
    if (!re.test(text)) continue;
    return canonicalizeCatalogConstraints({ category: display }).category;
  }
  return null;
}

function navigationConstraintsFromChip(inner, catalogCategories) {
  const out = {};
  const gender = chipGender(inner);
  const category = categoryFromChip(inner, catalogCategories);
  const color = normalizeColor(inner);
  if (gender) out.gender = gender;
  if (category) out.category = category;
  if (color) out.color = color;
  return out;
}

// Final catalog-grounding boundary for product-navigation chips.
// It recognizes only product facets the shared CatalogFacetIndex can prove
// (gender/category/color); clinical orthotic choices and ordinary prose chips
// pass through untouched. A recognized chip survives only when at least one
// live catalog tuple satisfies the current scope plus that choice.
export function filterCatalogScopedNavigationChips(
  text,
  {
    constraints = {},
    facetIndex = null,
    allowedCategories = [],
    catalogCategories = [],
    umbrellaCategoryTerms = [],
  } = {},
) {
  if (!text || typeof text !== "string" || !facetIndex) {
    return { text: text || "", stripped: [] };
  }

  const stripped = [];
  const out = text.replace(/<<([^<>|]+)>>/g, (match, inner) => {
    const choice = navigationConstraintsFromChip(inner, catalogCategories);
    if (Object.keys(choice).length === 0) return match;
    // Single shared verdict (catalog-matcher) so base-scope
    // sanitization — out-of-vocabulary carried-over values like the
    // umbrella "footwear" group name (2026-06-12 trace) — applies
    // identically to chips and follow-up suggestions.
    const verdict = catalogScopedNavigationQuestionVerdict({
      question: inner,
      choice,
      constraints,
      facetIndex,
      allowedCategories,
      umbrellaCategoryTerms,
    });
    if (verdict.possible) return match;
    stripped.push(inner.trim());
    return "";
  });

  return {
    text: out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
    stripped,
  };
}
