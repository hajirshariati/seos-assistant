import {
  catalogScopeHasMatches,
  canonicalizeCatalogConstraints,
  deriveCatalogMatchContract,
  readAttributeCI,
} from "./catalog-matcher.server.js";
import { normalizeCategory, normalizeColor, normalizeGender } from "./catalog-facts.server.js";
import {
  detectAiNoMatchPhrasing,
  resolverPromisedRecommendation,
  stripAvailabilityDenialSentences,
} from "./chat-postprocessing.js";
import { sanitizeCtaLabel } from "./cta-label.server.js";
import { buildStorefrontSearchCTA } from "./storefront-search-cta.server.js";
import { claimSourcesChecked } from "./product-claim-facts.server.js";
import {
  canonicalizeVariantConstraints,
  normalizeVariantSize,
  normalizeVariantWidth,
} from "./variant-matcher.server.js";

// Customer question shapes where the LLM was actively answering a
// meta question about the products (reviews, ratings, returns, fit,
// sizing). Used to gate the code-owned product listing override so
// it doesn't replace the LLM's answer with a generic "I found N
// products" template on those turns. Mirrors REVIEW_SHAPED_RE in
// product-turn-engine but inlined to avoid a cross-module dependency.
const REVIEW_FIT_RETURN_SHAPE_RE =
  /\b(?:review|reviews|rated|rating|ratings|reviewed|star|stars|score|scored|popular|best[- ]?selling|bestseller|highest|lowest|best|worst|customer[s']*\s+(?:say|saying|love|favor)|what\s+(?:do\s+)?(?:people|customers|buyers|others)\s+(?:say|think))\b|\b(?:return|returns|returned|retun|refund|refunds|exchange|exchanges)\b|\b(?:run|runs|running|fit|fits|fitting)\s+(?:small|big|large|true|narrow|wide|tight|loose)\b|\btrue\s+to\s+size\b|\bdo(?:es)?\s+(?:this|these|they)\s+(?:fit|run|feel)\b|\bhow\s+(?:do|does)\s+(?:this|these|they)\s+fit\b|\bsize\s+up\b|\bsize\s+down\b/i;

const SIBLING_GENERIC_WORDS = new Set([
  "the", "a", "an", "for", "and", "or", "in", "on", "with", "men", "mens",
  "women", "womens", "black", "white", "tan", "brown", "red", "blue", "grey",
  "gray", "pink", "dark", "light", "w", "s",
]);

function cardTitleTokens(title) {
  return new Set(
    (title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !SIBLING_GENERIC_WORDS.has(w)),
  );
}

export function dropSiblingCards(scored, textLower) {
  const kept = [];
  for (const candidate of scored) {
    const candTokens = cardTitleTokens(candidate.card.title);
    let drop = false;
    for (const k of kept) {
      const keptTokens = cardTitleTokens(k.card.title);
      if (candTokens.size === 0 || keptTokens.size === 0) continue;
      let shared = 0;
      for (const w of candTokens) if (keptTokens.has(w)) shared++;
      const sharedRatio = shared / Math.min(candTokens.size, keptTokens.size);
      if (sharedRatio < 0.8) continue;
      let extraUnmentioned = 0;
      for (const w of candTokens) {
        if (!keptTokens.has(w) && !textLower.includes(w)) extraUnmentioned++;
      }
      if (extraUnmentioned >= 1) {
        drop = true;
        break;
      }
    }
    if (!drop) kept.push(candidate);
  }
  return kept;
}

export function scoreCardAgainstText(card, textLower, userTextLower) {
  const raw = card.title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const generic = new Set(["the", "a", "an", "for", "and", "or", "in", "on", "with", "men", "mens", "women", "womens", "black", "white", "tan", "brown", "red", "blue", "grey", "gray", "pink", "dark", "light"]);
  const nameWords = raw.filter((w) => !generic.has(w));
  // 1. Title vs response text — "did the AI name this product?"
  const titleScore = nameWords.length === 0 ? 0 : nameWords.filter((w) => textLower.includes(w)).length / nameWords.length;

  // 2. User question vs card title — "does this product match what the
  // customer asked about?" Missing this signal was the original sin
  // behind the display-boundary fallback: when the LLM wrote vague
  // text ("Here are some options:") with no specific product names,
  // titleScore went to 0 for every card and the scorer dropped them
  // all — even when the cards clearly matched the customer's intent
  // ("show me sandals" → every sandal card has "sandal" in the title).
  // Display-boundary was bolted on to compensate. This signal is the
  // upstream fix.
  let userTitleScore = 0;
  if (userTextLower && nameWords.length > 0) {
    const userWords = userTextLower
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !generic.has(w) && !["what", "does", "mean", "tell", "about", "show", "find", "have", "you", "your", "the"].includes(w));
    if (userWords.length > 0) {
      userTitleScore = nameWords.filter((w) => userWords.some((uw) => w.includes(uw) || uw.includes(w))).length / nameWords.length;
    }
  }

  // 3. User question vs description snippet — "does this product's
  // description discuss what the customer asked about?" Captures
  // technology/feature queries when the term is in the description.
  let queryScore = 0;
  const snippet = (card._descriptionSnippet || "").toLowerCase();
  const searchQ = (card._searchQuery || "").toLowerCase().trim();
  if (snippet && userTextLower) {
    const distinctive = userTextLower
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !generic.has(w) && !["what", "does", "mean", "tell", "about", "show", "find"].includes(w));
    if (distinctive.length > 0) {
      const hits = distinctive.filter((w) => snippet.includes(w)).length;
      queryScore = hits / distinctive.length;
    }
  }
  if (snippet && searchQ && snippet.includes(searchQ)) {
    queryScore = Math.max(queryScore, 1);
  }

  return Math.max(titleScore, userTitleScore, queryScore);
}

export const SKU_PATTERN = /\b[A-Z]{1,2}\d{3,5}[A-Z]?\b/g;

export function skusFromCardText(value) {
  if (!value) return [];
  return String(value).toUpperCase().match(SKU_PATTERN) || [];
}

export function extractOrphanSkus(text, pool) {
  const mentioned = text.match(SKU_PATTERN) || [];
  if (mentioned.length === 0) return [];
  const poolSkuSet = new Set();
  for (const card of pool) {
    for (const s of skusFromCardText(card.title)) poolSkuSet.add(s);
    for (const s of skusFromCardText(card.handle)) poolSkuSet.add(s);
  }
  const seen = new Set();
  const orphans = [];
  for (const raw of mentioned) {
    const sku = raw.toUpperCase();
    if (seen.has(sku)) continue;
    seen.add(sku);
    if (!poolSkuSet.has(sku)) orphans.push(sku);
  }
  return orphans;
}

export function stripMissingSkus(text, missing) {
  if (!text || missing.length === 0) return text;
  let cleaned = text;
  for (const sku of missing) {
    const safe = sku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`\\s*\\(\\s*${safe}\\s*\\)`, "gi"), "");
    cleaned = cleaned.replace(new RegExp(`\\b${safe}\\b`, "gi"), "");
  }
  return cleaned
    .replace(/\(\s*\)/g, "")
    .replace(/\bI don't see\s+(?:an?|the)\s+(?=in\s+(?:our\s+)?catalog\b)/i, "I don't see that ")
    .replace(/\b(and|or|,)\s*(?=(?:and|or|,|are|is|both)\b)/gi, " ")
    .replace(/\b(both|and)\s+(are|is)\b/gi, "$2")
    .replace(/\bare\s+(?:both\s+)?great\s+picks\b/gi, "is a great pick")
    .replace(/\bare\s+(?:both\s+)?(great|excellent|solid|nice)\b/gi, "is $1")
    .replace(/,\s*,/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SUPPORT_ANCHOR_RE = /\b(contact|customer\s+(service|care|support)|support\s+(hub|team|center)|support|care\s+team|help\s+team|reach\s+(out|us)|our\s+team|speak.*(human|agent|rep|person))\b/i;

function normalizeUrl(u) {
  return String(u || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

export function extractSupportCTA(text, supportUrl, supportLabel) {
  if (!text) return { text, cta: null };

  const defaultOldLabel = "Contact customer service";
  const label = supportLabel && supportLabel.trim() && supportLabel.trim() !== defaultOldLabel
    ? supportLabel.trim()
    : "Visit Support Hub";

  const normSupport = supportUrl ? normalizeUrl(supportUrl) : "";
  const mdLinkAny = /\[([^\]]+)\]\(\s*([^)\s]+)\s*\)/g;

  const removals = [];
  let cta = null;
  let m;
  while ((m = mdLinkAny.exec(text)) !== null) {
    const anchor = m[1];
    const linkUrl = m[2];
    const normLink = normalizeUrl(linkUrl);
    const anchorMatch = SUPPORT_ANCHOR_RE.test(anchor);
    const urlMatch = normSupport && (normLink === normSupport || normLink.includes(normSupport) || normSupport.includes(normLink));
    if (anchorMatch || urlMatch) {
      removals.push({ start: m.index, end: m.index + m[0].length });
      if (!cta) cta = { url: supportUrl || linkUrl, label };
    }
  }

  let cleaned = text;
  for (let i = removals.length - 1; i >= 0; i--) {
    cleaned = cleaned.slice(0, removals[i].start) + cleaned.slice(removals[i].end);
  }

  if (supportUrl) {
    const safeUrl = supportUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bareUrl = new RegExp(`(?<![\\w(\\[])${safeUrl}/?(?![\\w)])`, "gi");
    if (bareUrl.test(cleaned)) {
      cleaned = cleaned.replace(bareUrl, "");
      if (!cta) cta = { url: supportUrl, label };
    }
  }

  if (!cta) return { text, cta: null };

  cleaned = cleaned
    .replace(/:\s*$/gm, ".")
    .replace(/\s+here\s*[.:!]?\s*$/gim, ".")
    .replace(/\s*\(\s*\)/g, "")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\.{2,}/g, ".")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text: cleaned, cta };
}

export function extractCollectionCTA(text) {
  const match = text.match(/<<(.+?)\|(.+?)>>/);
  if (!match) return { text, cta: null };

  return {
    text: text.replace(match[0], "").trim(),
    cta: {
      label: sanitizeCtaLabel(match[1], match[2]),
      url: match[2],
    },
  };
}

export function extractGenericCTA(text) {
  const mdLink = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
  const rawLink = /(https?:\/\/[^\s]+)/;

  // After we strip a markdown link out of the prose, clean up any
  // orphan formatting markers the LLM bracketed it with — e.g.
  // "check **[Store Locator](url)** today" leaves "check **** today"
  // which renders as visible asterisks. Also collapse double spaces
  // and leading punctuation hangovers like "today: " followed by
  // nothing.
  const cleanOrphans = (s) => String(s || "")
    .replace(/\*{2,}/g, "")              // orphan ** / ****
    .replace(/(?:^|\s)_{2,}(?=\s|$)/g, " ") // orphan __
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")     // " ," → ","
    .replace(/([:,;])\s*(?=$|\n)/g, "$1") // dangling "today: "
    .trim();

  let match = text.match(mdLink);
  if (match) {
    return {
      text: cleanOrphans(text.replace(match[0], "")),
      cta: { url: match[2], label: sanitizeCtaLabel(match[1], match[2]) },
    };
  }

  match = text.match(rawLink);
  if (match) {
    return {
      text: cleanOrphans(text.replace(match[0], "")),
      cta: { url: match[1], label: sanitizeCtaLabel("", match[1]) },
    };
  }

  return { text, cta: null };
}

const FAMILY_STOP_WORDS_UI = new Set(["the", "a", "an", "my", "our", "new"]);

export function titleStyleFamily(title) {
  if (!title) return "";
  const beforeDash = String(title).split(/\s[-–—]\s/)[0];
  const words = beforeDash
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const w of words) {
    if (w.length > 2 && !FAMILY_STOP_WORDS_UI.has(w)) return w;
  }
  return "";
}

// Detect bold product references in AI text and check whether ANY
// pool card shares a family with them. Used by the named-product
// mismatch guard in chat.jsx — when the AI bolds a product name
// (e.g. "**Andrea Quarter Strap Wedge - Black**") but no pool card
// matches that family, the displayed cards belong to a different
// product than the text describes. Better to wipe than render.
//
// Returns { textFamilies: string[], poolFamilies: string[],
//           overlap: boolean }
// Pure title-token math — no merchant-specific vocabulary.
export function detectNamedProductMismatch(text, pool) {
  const out = { textFamilies: [], poolFamilies: [], overlap: true };
  if (!text || !Array.isArray(pool) || pool.length === 0) return out;
  const boldMatches = String(text).match(/\*\*([^*]{3,80})\*\*/g) || [];
  const productNames = boldMatches
    .map((b) => b.replace(/^\*\*|\*\*$/g, "").trim())
    .filter((n) => {
      if (n.length < 5) return false;
      if (!/[A-Z]/.test(n)) return false;
      // Skip generic emphasis bolds — "Great news!" / "Important" etc.
      if (/^(?:yes|no|note|important|warning|tip|here|now|today|great)\b/i.test(n)) return false;
      // Skip technology / feature / brand bolds. Trademark/registered
      // symbols and "Technology"/"System"/"Method"/"Feature" suffixes
      // signal the LLM is naming a tech concept, not a product family.
      // Live 2026-06-08: customer asked "what makes BioRocker different?"
      // LLM bolded "**BioRocker™ Technology**". Guard treated "biorocker"
      // as a product family, found no overlap with pool families
      // [darcy,savannah,jenny,...] (which ARE the BioRocker products),
      // and wiped the entire pool — customer saw the explanation with
      // zero products attached.
      if (/[™®©]/.test(n)) return false;
      if (/\b(?:Technology|System|Method|Approach|Feature|Series|Collection|Platform|Footbed|Midsole|Outsole|Insole|Foam|Material|Lining|Upper)\b/i.test(n)) return false;
      return true;
    });
  const textFamilies = new Set(
    productNames.map((name) => titleStyleFamily(name)).filter(Boolean),
  );
  const poolFamilies = new Set(
    pool.map((card) => titleStyleFamily(card?.title || "")).filter(Boolean),
  );
  out.textFamilies = [...textFamilies];
  out.poolFamilies = [...poolFamilies];
  if (textFamilies.size === 0) {
    out.overlap = true; // no bold names → nothing to compare against
    return out;
  }
  out.overlap = [...textFamilies].some((fam) => poolFamilies.has(fam));
  return out;
}

const FOOTWEAR_HYPERNYMS = ["shoe", "shoes", "footwear"];
const FOOTWEAR_CATEGORY_SET = new Set([
  "footwear", "sneakers", "sneaker", "boots", "boot", "sandals", "sandal",
  "clogs", "clog", "loafers", "loafer", "oxfords", "oxford", "slip ons", "slip-ons",
  "wedges heels", "mary janes", "slippers", "slipper", "heels", "flats", "mules",
]);

export function detectFalseCategoryDenial(text, categories) {
  if (!text || !Array.isArray(categories) || categories.length === 0) return null;
  const t = String(text);
  const lower = t.toLowerCase();
  const hasFootwearFamily = categories.some((cat) => FOOTWEAR_CATEGORY_SET.has(String(cat || "").trim().toLowerCase()));
  const checks = categories.map((cat) => ({ cat, displayName: cat }));
  if (hasFootwearFamily) {
    for (const h of FOOTWEAR_HYPERNYMS) {
      checks.push({ cat: h, displayName: "Footwear" });
    }
  }

  for (const { cat, displayName } of checks) {
    const c = String(cat || "").trim().toLowerCase();
    if (!c || c.length < 3) continue;
    const stem = c.endsWith("s") ? c.slice(0, -1) : c;
    const variants = c === stem ? [c] : [c, stem];
    const alt = variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const denialPatterns = [
      new RegExp(`\\(\\s*not\\s+(?:${alt})s?\\s*\\)`, "i"),
      new RegExp(`\\bwe (?:don'?t|do not|cannot|can'?t) (?:have|carry|sell|stock|offer)\\s+(?:any\\s+)?(?:${alt})s?\\b`, "i"),
      new RegExp(`\\b(?:this|the)\\s+(?:store|shop)\\s+(?:doesn'?t|does not)\\s+(?:have|carry|sell|stock|offer)\\s+(?:any\\s+)?(?:${alt})s?\\b`, "i"),
      new RegExp(`\\b(?:${alt})s?\\s+(?:are\\s+not|aren'?t|is\\s+not|isn'?t)\\s+(?:something|a category|a product|a line)\\s+(?:we|this store|the store)\\s+(?:carry|carries|sell|sells|stock|stocks|offer|offers)\\b`, "i"),
      new RegExp(`\\bno\\s+(?:${alt})s?\\s+(?:in|at|from)\\s+(?:this|the|our)\\s+(?:store|shop|catalog)\\b`, "i"),
    ];
    for (const re of denialPatterns) {
      if (re.test(t) || re.test(lower)) return displayName;
    }
  }
  return null;
}

export function detectFalseGenderCategoryAffirmation(text, categoryGenderMap) {
  if (!text || !categoryGenderMap || typeof categoryGenderMap !== "object") return null;
  const t = String(text);
  const lower = t.toLowerCase();
  const entries = Object.entries(categoryGenderMap);
  if (entries.length === 0) return null;

  const sorted = entries
    .filter(([k]) => k && k.length >= 3)
    .sort((a, b) => b[0].length - a[0].length);

  const genderToTokens = {
    men: ["men's", "men", "mens", "male", "guy", "guys", "gentleman", "gentlemen", "boys'", "boys"],
    women: ["women's", "women", "womens", "female", "lady", "ladies", "girls'", "girls"],
  };

  for (const [catKey, entry] of sorted) {
    if (!entry || !Array.isArray(entry.genders) || entry.genders.length === 0) continue;
    if (entry.genders.includes("unisex")) continue;
    const supported = new Set(entry.genders.map((g) => String(g).toLowerCase()));
    const missingGenders = ["men", "women"].filter((g) => !supported.has(g));
    if (missingGenders.length === 0) continue;

    const c = String(catKey).toLowerCase().trim();
    const stem = c.endsWith("s") ? c.slice(0, -1) : c;
    const variants = c === stem ? [c] : [c, stem];
    const escapedCats = variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const catAlt = escapedCats.map((v) => `${v}s?`).join("|");

    for (const missingGender of missingGenders) {
      const tokens = genderToTokens[missingGender] || [];
      const escapedTokens = tokens.map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const tokenAlt = escapedTokens.join("|");
      const verbAlt = "have|carry|sell|stock|offer|got";
      const affirmPatterns = [
        new RegExp(`\\bwe (?:absolutely\\s+)?(?:do (?:${verbAlt})|${verbAlt})\\s+(?:some\\s+|a\\s+few\\s+)?(?:${tokenAlt})\\s+(?:${catAlt})\\b`, "i"),
        new RegExp(`\\byes,?\\s+we (?:absolutely\\s+)?(?:do |${verbAlt})\\s+(?:some\\s+|a\\s+few\\s+)?(?:${tokenAlt})\\s+(?:${catAlt})\\b`, "i"),
        new RegExp(`\\b(?:these|those|here are)\\s+(?:are\\s+)?(?:some\\s+|a\\s+few\\s+|our\\s+)?(?:${tokenAlt})\\s+(?:${catAlt})\\b`, "i"),
        new RegExp(`\\bour\\s+(?:${tokenAlt})\\s+(?:${catAlt})\\b`, "i"),
      ];
      for (const re of affirmPatterns) {
        if (re.test(t) || re.test(lower)) {
          return {
            category: entry.display || catKey,
            requestedGender: missingGender === "men" ? "men's" : "women's",
            availableGenders: entry.genders.slice(),
          };
        }
      }
    }
  }
  return null;
}

function flattenValues(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(flattenValues);
  if (typeof value === "object") return Object.values(value).flatMap(flattenValues);
  return [String(value)];
}

function cardAttr(card, aliases) {
  return readAttributeCI(card?._attributes || card?.attributes || {}, aliases);
}

function cardAttrValues(card, aliases) {
  const bag = card?._attributes || card?.attributes || {};
  return (Array.isArray(aliases) ? aliases : [])
    .flatMap((alias) => flattenValues(readAttributeCI(bag, [alias])))
    .filter(Boolean);
}

function cardMatchesColor(card, requestedColor) {
  const color = normalizeColor(requestedColor);
  if (!color) return true;
  const rawValues = [
    cardAttr(card, ["color", "colour", "color_family", "Color Family", "color_fallback"]),
    card?.title,
  ];
  return flattenValues(rawValues).some((value) => normalizeColor(value) === color);
}

export function currentCatalogScopeFromContext(ctx = {}) {
  const explicit = ctx.sessionMemory?.explicit || {};
  const classified = ctx.classifiedIntent?.attributes || {};
  const resolverMatched = ctx.resolverState?.matched_constraints || {};
  const resolverInferred = ctx.resolverState?.inferred_constraints || {};

  return canonicalizeCatalogConstraints({
    gender:
      explicit.gender ||
      classified.gender ||
      resolverMatched.gender ||
      resolverInferred.gender?.value ||
      ctx.sessionGender,
    category:
      explicit.category ||
      classified.category ||
      resolverMatched.category ||
      resolverInferred.category?.value,
    color:
      explicit.color ||
      classified.color ||
      resolverMatched.color ||
      resolverInferred.color?.value,
    size:
      explicit.size ||
      resolverMatched.size,
    width:
      explicit.width ||
      resolverMatched.width,
  });
}

export function productPoolSatisfiesCatalogScope(pool, scope = {}) {
  if (!Array.isArray(pool) || pool.length === 0) return false;
  const canonical = canonicalizeCatalogConstraints(scope);
  const gender = normalizeGender(canonical.gender);
  const category = normalizeCategory(canonical.category);
  const color = normalizeColor(canonical.color);
  if (!gender && !category && !color) return false;

  return pool.some((card) => {
    const cardGender =
      normalizeGender(card?._gender) ||
      normalizeGender(cardAttr(card, ["gender", "gender_fallback", "genders"]));
    const cardCategory =
      normalizeCategory(card?._category) ||
      normalizeCategory(card?.productType) ||
      normalizeCategory(cardAttr(card, ["category", "category_for_filter", "subcategory", "product_type"]));

    if (gender && cardGender && cardGender !== gender && cardGender !== "unisex") return false;
    if (category && cardCategory && cardCategory !== category) return false;
    if (color && !cardMatchesColor(card, color)) return false;
    if (!cardVerifiedVariantScope(card, canonical)) return false;
    return true;
  });
}

function cardMatchesCatalogScope(card, scope = {}, { enforceColor = true, requireKnown = false } = {}) {
  const canonical = canonicalizeCatalogConstraints(scope);
  const gender = normalizeGender(canonical.gender);
  const category = normalizeCategory(canonical.category);
  const color = normalizeColor(canonical.color);

  const cardGender =
    normalizeGender(card?._gender) ||
    normalizeGender(cardAttr(card, ["gender", "gender_fallback", "genders"]));
  const cardCategory =
    normalizeCategory(card?._category) ||
    normalizeCategory(card?.productType) ||
    normalizeCategory(cardAttr(card, ["category", "category_for_filter", "subcategory", "product_type"]));

  if (gender && requireKnown && !cardGender) return false;
  if (category && requireKnown && !cardCategory) return false;
  if (gender && cardGender && cardGender !== gender && cardGender !== "unisex") return false;
  if (category && cardCategory && cardCategory !== category) {
    // Umbrella match: scope.category="footwear" is a hypernym for
    // every concrete footwear sub-category. Without this rule the
    // filter wipes sandal/sneaker/boot cards when a stale broad-
    // footwear scope is carried over from a prior turn. Live trace
    // 2026-06-08: "compare Vicki and Jillian" → cards returned were
    // sandals, scope.category=footwear (stale), all dropped, empty-
    // pool repair erased the LLM's comparison.
    const scopeIsFootwearUmbrella = category === "footwear";
    const cardIsFootwearSub = FOOTWEAR_CATEGORY_SET.has(cardCategory);
    if (!(scopeIsFootwearUmbrella && cardIsFootwearSub)) return false;
  }
  if (color && enforceColor && !cardMatchesColor(card, color)) return false;
  return true;
}

function cardVerifiedVariantScope(card, scope = {}) {
  const canonical = canonicalizeVariantConstraints(scope);
  if (!canonical.size && !canonical.width && !canonical.sku) return true;

  const stamped = canonicalizeVariantConstraints(card?._variantScope || card?._matchedVariantScope || {});
  if (canonical.sku && stamped.sku === canonical.sku) return true;
  if (
    canonical.size &&
    stamped.size === canonical.size &&
    (!canonical.width || stamped.width === canonical.width)
  ) {
    return true;
  }
  if (canonical.width && !canonical.size && stamped.width === canonical.width) return true;

  const facts = card?._variantFacts || card?.variantFacts || {};
  const sizes = flattenValues([facts.availableSizes, facts.sizes])
    .map(normalizeVariantSize)
    .filter(Boolean);
  const widths = flattenValues([facts.availableWidths, facts.widths])
    .map(normalizeVariantWidth)
    .filter(Boolean);

  const sizeOk = !canonical.size || sizes.includes(canonical.size);
  const widthOk = !canonical.width || widths.includes(canonical.width);

  // A size+width combination is only safe when the search/tool stamped the
  // exact variant scope on the card. Separate size and width lists do not
  // prove the same variant carries both.
  if (canonical.size && canonical.width) return false;
  return sizeOk && widthOk;
}

export function filterProductCardsToCatalogScope(pool = [], ctx = {}, { strict = false } = {}) {
  let products = Array.isArray(pool) ? pool.filter(Boolean) : [];
  if (products.length === 0) {
    return { products: [], dropped: 0, scope: currentCatalogScopeFromContext(ctx), enforcedColor: false };
  }
  // Under llm-owns, the model already filtered to what it wants to show — stale
  // session memory (e.g. color=pink from a prior turn) must not silently drop
  // a fresh search result the model just decided to mention. The grounding
  // validator polices accuracy instead.
  if (isLlmOwnsTurnActive()) {
    return { products, dropped: 0, scope: currentCatalogScopeFromContext(ctx), enforcedColor: false };
  }
  const originalProductCount = products.length;

  const scope = currentCatalogScopeFromContext(ctx);
  const canonical = canonicalizeCatalogConstraints(scope);
  if (strict && Array.isArray(ctx.catalogScopeCategories) && ctx.catalogScopeCategories.length > 0) {
    const allowed = new Set(
      ctx.catalogScopeCategories
        .map((category) => normalizeCategory(category))
        .filter(Boolean),
    );
    if (allowed.size > 0) {
      products = products.filter((card) => {
        const category =
          normalizeCategory(card?._category) ||
          normalizeCategory(card?.productType) ||
          normalizeCategory(cardAttr(card, ["category", "category_for_filter", "subcategory", "product_type"]));
        return Boolean(category) && allowed.has(category);
      });
    }
  }
  const hasStructuralScope = Boolean(canonical.gender || canonical.category);
  if (!hasStructuralScope && !canonical.color) {
    return { products, dropped: originalProductCount - products.length, scope, enforcedColor: false };
  }

  const structuralMatches = products.filter((card) =>
    cardMatchesCatalogScope(card, canonical, { enforceColor: false, requireKnown: strict }),
  );
  const base = hasStructuralScope ? structuralMatches : products;
  if (base.length === 0) {
    return { products: [], dropped: originalProductCount, scope, enforcedColor: false };
  }

  // Color is a hard display constraint only when we have ENOUGH literal
  // matches to satisfy the customer. Production trace: customer asked
  // "pink sandals", search returned 6 candidates, only 1 was tagged
  // literally "Pink" (the other 5 were Blush, Coral, Rose, etc — all
  // shades of pink that real customers would call pink). The old logic
  // kept just the 1, hiding 5 valid options. New rule: if literal
  // matches are ≥2, enforce literal (we have a real pink line). If
  // literal is just 1 AND we have a broader structural pool of ≥3,
  // show the broader set — the listing line will say "pink and similar"
  // so the customer knows.
  let enforcedColor = false;
  let filtered = base;
  if (canonical.color) {
    if (strict) {
      filtered = base.filter((card) =>
        cardMatchesCatalogScope(card, canonical, { enforceColor: true, requireKnown: true }),
      );
      enforcedColor = true;
    } else {
      const literalColor = base.filter((card) => cardMatchesLiteralColor(card, canonical.color));
      const semanticColor = base.filter((card) =>
        cardMatchesCatalogScope(card, canonical, { enforceColor: true }),
      );
      if (literalColor.length >= 2) {
        filtered = literalColor;
        enforcedColor = true;
      } else if (literalColor.length === 1 && base.length < 3) {
        // Tiny pool — the single literal match is what we have.
        filtered = literalColor;
        enforcedColor = true;
      } else if (literalColor.length >= 1 && base.length >= 3) {
        // Mixed pool — show literal + closest semantic siblings; the
        // listing text will frame as "pink and similar".
        filtered = base;
        enforcedColor = false;
      } else if (semanticColor.length > 0) {
        filtered = semanticColor;
        enforcedColor = true;
      }
    }
  }

  const variantScope = canonicalizeVariantConstraints(canonical);
  if (variantScope.size || variantScope.width || variantScope.sku) {
    filtered = filtered.filter((card) => cardVerifiedVariantScope(card, variantScope));
  }

  return {
    products: filtered,
    dropped: originalProductCount - filtered.length,
    scope,
    enforcedColor,
  };
}

function addCardsToPool(cards, allProductPool) {
  if (!(allProductPool instanceof Map)) return 0;
  let added = 0;
  for (const card of Array.isArray(cards) ? cards : []) {
    const key = card?.handle || card?.title;
    if (key && !allProductPool.has(key)) {
      allProductPool.set(key, card);
      added += 1;
    }
  }
  return added;
}

async function attachResolverCandidateCards({ ctx, allProductPool, dispatchTool, extractProductCards, reason }) {
  if (!Array.isArray(ctx?.resolverState?.candidate_products)) return 0;
  const handles = ctx.resolverState.candidate_products
    .map((p) => p?.handle)
    .filter(Boolean)
    .slice(0, 6);
  if (handles.length === 0) return 0;

  let attached = 0;
  console.log(`[chat] ${reason}: attaching ${handles.length} resolver candidate handle(s)`);
  for (const handle of handles) {
    try {
      const details = await dispatchTool("get_product_details", { handle }, ctx);
      attached += addCardsToPool(extractProductCards("get_product_details", details), allProductPool);
    } catch (err) {
      console.error(`[chat] ${reason}: resolver candidate ${handle} failed`, err?.message || err);
    }
  }
  return attached;
}

function resolverRequiresExactNoMatch(resolverState) {
  if (!resolverState || resolverState.type !== "resolver_state") return false;
  return (
    resolverState.recommended_next_action?.type === "no_match" ||
    (Array.isArray(resolverState.impossible_constraints) && resolverState.impossible_constraints.length > 0)
  );
}

export async function ensureProductTurnCards({
  ctx = {},
  allProductPool,
  dispatchTool,
  extractProductCards,
  searchInput,
  shouldAttach = false,
  allowRelaxedNoMatch = false,
  reason = "product turn",
} = {}) {
  if (!(allProductPool instanceof Map)) {
    return { products: [], attached: 0, searchAttempted: false, diagnostics: { rung: "no-pool" } };
  }

  const diagnostics = { rung: "existing", scope: currentCatalogScopeFromContext(ctx), reason };
  const exactNoMatch = resolverRequiresExactNoMatch(ctx.resolverState) && !allowRelaxedNoMatch;
  diagnostics.exactNoMatch = exactNoMatch;
  let searchAttempted = false;
  let attached = 0;

  const scopedProducts = () => {
    const products = Array.from(allProductPool.values());
    const scoped = filterProductCardsToCatalogScope(products, ctx, { strict: exactNoMatch });
    if (scoped.dropped > 0) {
      console.log(
        `[chat] response-contract: dropped ${scoped.dropped} off-scope card(s) ` +
          `before emit (gender=${scoped.scope.gender || "-"} category=${scoped.scope.category || "-"} ` +
          `color=${scoped.scope.color || "-"} enforcedColor=${scoped.enforcedColor ? "yes" : "no"})`,
      );
    }
    if (scoped.products.length === 0 && products.length > 0 && resolverPromisedRecommendation(ctx.resolverState)) {
      console.log(
        `[chat] response-contract: resolver promised recommendation; keeping ${products.length} candidate card(s) ` +
          `after display scope filter wiped all`,
      );
      return products;
    }
    return scoped.products;
  };

  let products = scopedProducts();
  if (products.length > 0 || !shouldAttach) {
    return { products, attached, searchAttempted, diagnostics };
  }

  if (!exactNoMatch && resolverPromisedRecommendation(ctx.resolverState) && dispatchTool && extractProductCards) {
    attached += await attachResolverCandidateCards({
      ctx,
      allProductPool,
      dispatchTool,
      extractProductCards,
      reason: "product-turn cards",
    });
    products = scopedProducts();
    if (products.length > 0) {
      diagnostics.rung = "resolver-candidates";
      console.log(`[chat] product-turn cards: attached ${attached} card(s); final=${products.length}; rung=${diagnostics.rung}`);
      return { products, attached, searchAttempted, diagnostics };
    }
  }

  const input = searchInput?.input || searchInput || {};
  const scope = searchInput?.scope || diagnostics.scope || {};
  if (dispatchTool && extractProductCards) {
    console.log(
      `[chat] product-turn cards: ${reason}; forcing scoped search ` +
        `(gender=${scope.gender || "-"} category=${scope.category || "-"} color=${scope.color || "-"} ` +
        `query=${JSON.stringify(input.query || "")})`,
    );
    try {
      searchAttempted = true;
      const found = await dispatchTool("search_products", input, ctx);
      attached += addCardsToPool(extractProductCards("search_products", found), allProductPool);
      diagnostics.rung = "scoped-search";
    } catch (err) {
      console.error("[chat] product-turn cards scoped search failed:", err?.message || err);
      diagnostics.rung = "scoped-search-error";
    }
  }

  if (!exactNoMatch && attached === 0 && input?.filters?.color && (input.filters.category || input.filters.gender) && dispatchTool && extractProductCards) {
    const relaxedFilters = { ...input.filters };
    delete relaxedFilters.color;
    const relaxedQuery = [scope.condition, scope.category]
      .filter(Boolean)
      .join(" ")
      .trim() || String(ctx?.latestUserMessage || "").slice(0, 160).trim() || "shoes";
    console.log(
      `[chat] product-turn cards: exact color search empty; relaxing color while keeping ` +
        `gender=${relaxedFilters.gender || "-"} category=${relaxedFilters.category || "-"}`,
    );
    try {
      searchAttempted = true;
      const relaxed = await dispatchTool("search_products", {
        ...input,
        query: relaxedQuery,
        filters: relaxedFilters,
        _suppressColorInjection: true,
      }, ctx);
      attached += addCardsToPool(extractProductCards("search_products", relaxed), allProductPool);
      if (attached > 0) diagnostics.rung = "color-relaxed-search";
    } catch (err) {
      console.error("[chat] product-turn cards relaxed search failed:", err?.message || err);
    }
  }

  if (!exactNoMatch && attached === 0) {
    attached += await attachResolverCandidateCards({
      ctx,
      allProductPool,
      dispatchTool,
      extractProductCards,
      reason: "product-turn cards",
    });
    if (attached > 0) diagnostics.rung = "resolver-candidates";
  }

  products = scopedProducts();
  if (exactNoMatch && products.length === 0) diagnostics.rung = "exact-no-match";
  console.log(`[chat] product-turn cards: attached ${attached} card(s); final=${products.length}; rung=${diagnostics.rung}`);
  return { products, attached, searchAttempted, diagnostics };
}

export function deriveProductResponseContract({ pool = [], ctx = {}, relaxedFilters = null } = {}) {
  const scope = currentCatalogScopeFromContext(ctx);
  const exactScopeSatisfied = productPoolSatisfiesCatalogScope(pool, scope);
  const resolver = ctx.resolverState;
  const impossibleConstraints =
    resolver?.type === "resolver_state" && Array.isArray(resolver.impossible_constraints)
      ? resolver.impossible_constraints
      : [];

  return {
    ...deriveCatalogMatchContract({
      products: pool,
      constraints: scope,
      relaxedFilters,
      impossibleConstraints,
    }),
    exactScopeSatisfied,
  };
}

const PRODUCT_INTRO_RE = /\b(?:here (?:are|is)|take a look|check out|i found|we have|these are|this is|good news|great news|closest options|matching styles)\b/i;
const CLARIFYING_LEAD_RE = /^\s*(?:what|which)\s+(?:type|kind|style|category)\s+of\s+[^?]{1,160}\?\s*/i;
const GENDER_CLARIFYING_LEAD_RE = /^\s*(?:is this|are these|who (?:is|are) (?:this|these)|would this be)\s+[^?]{0,120}\?\s*/i;

function stripChoiceButtons(text) {
  return String(text || "")
    .replace(/\s*<<[^<>]+>>/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function repairProductTurnAssembly({ text, pool = [], ctx = {}, relaxedFilters = null } = {}) {
  let nextText = String(text || "").trim();
  let changed = false;
  const logs = [];
  // Phase 4 completion: on the LLM-owns path, ALL silent text
  // rewriters in this assembly defer to the grounding validator's
  // reject-and-retry. Live trace 2026-06-10 evening: "is the Jamie
  // wedge in stock?" → color repairs + enumeration collapse cut the
  // model's 334-char answer to 181 chars behind its back. The
  // legacy (kill-switch) path keeps every repair.
  const llmOwns = isLlmOwnsTurnActive();

  const denialRepair = repairProductResponseText({ text: nextText, pool, ctx, relaxedFilters });
  if (denialRepair.changed) {
    nextText = denialRepair.text;
    changed = true;
    logs.push("stripped_contradictory_denial");
  }

  const colorRepair = llmOwns
    ? { changed: false }
    : repairColorAvailabilityClaims(nextText, pool, ctx);
  if (colorRepair.changed) {
    nextText = colorRepair.text;
    changed = true;
    logs.push("verified_color_availability");
  }

  const positiveColorRepair = llmOwns
    ? { changed: false }
    : repairPositiveColorClaims(nextText, pool);
  if (positiveColorRepair.changed) {
    nextText = positiveColorRepair.text;
    changed = true;
    logs.push("corrected_color_overclaim");
  }

  if (!llmOwns && isDirectProductFactQuestion(ctx?.latestUserMessage)) {
    const colorRangeRepair = repairColorRangePromises(nextText, pool, ctx);
    if (colorRangeRepair.changed) {
      nextText = colorRangeRepair.text;
      changed = true;
      logs.push("completed_color_range_from_facts");
    }
  }

  // Claim verifier — single accuracy pass against per-card facts
  // (`_conditionTags` / `_useCaseTags` / `_onSale` / `_removableInsole`
  // attached by chat-tools.extractProductCards). Catches universal
  // feature claims, unverifiable concepts (waterproof / roomy toe box
  // / hiking when the merchant didn't tag for it), and sale claims
  // that don't hold across the displayed pool.
  // SKIPPED when LLM_OWNS_ALL_TURNS is active: the grounding validator
  // (app/lib/grounding-validator.server.js) is now the authority on
  // claim verification and it checks description/tags/attributes/
  // claim-facts (broader evidence base) before flagging. The legacy
  // verifier checks tag-only and ZEROES the text on failure — live
  // trace 2026-06-10: customer asked "which boots have memory foam?",
  // LLM wrote 172 chars from descriptions, verifier zeroed because
  // catalog `footbed` attribute is warehouse codes ("ll", "cc") not
  // "memory foam".
  const claimRepair = isLlmOwnsTurnActive()
    ? { changed: false, text: nextText, logs: [] }
    : verifyClaimsAgainstCards({ text: nextText, cards: pool });
  if (claimRepair.changed) {
    nextText = claimRepair.text;
    changed = true;
    logs.push(`verified_claims(${claimRepair.logs.join(",")})`);
  }

  // Per-product enumeration covering only some of the displayed cards
  // looks contradictory next to the cards the customer sees. Hunter
  // trace (color-iteration): bot wrote "Danika comes in… Carly comes
  // in…" but the cards also included Ivy, Charlotte, and Blake. The
  // missing names read as the bot hiding or forgetting products.
  // When this is detected, swap the partial enumeration for a single
  // honest line — the cards already render the names + colors. Runs
  // AFTER repairColorRangePromises because that step can ITSELF
  // introduce a partial enumeration (only cards with multi-color
  // variants get a "comes in…" sentence), which this cleanup catches.
  const partialEnum = llmOwns
    ? { changed: false }
    : collapsePartialPerProductEnumeration(nextText, pool);
  if (partialEnum.changed) {
    nextText = partialEnum.text;
    changed = true;
    logs.push("collapsed_partial_per_product_enumeration");
  }

  if (Array.isArray(pool) && pool.length > 0 && extractTurnChips(nextText).length > 0) {
    const firstChipIdx = nextText.indexOf("<<");
    const beforeChips = firstChipIdx >= 0 ? nextText.slice(0, firstChipIdx).trim() : nextText;
    const chipFree = stripChoiceButtons(nextText);
    const namesPoolProduct = pool.some((card) => {
      const title = String(card?.title || "").trim().toLowerCase();
      return title.length >= 5 && chipFree.toLowerCase().includes(title);
    });
    const presentsProducts =
      PRODUCT_INTRO_RE.test(chipFree) ||
      PRODUCT_INTRO_RE.test(beforeChips) ||
      namesPoolProduct;

    if (presentsProducts) {
      const stripped = stripChoiceButtons(chipFree)
        .replace(CLARIFYING_LEAD_RE, "")
        .replace(GENDER_CLARIFYING_LEAD_RE, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      if (stripped !== nextText) {
        nextText = stripped || "Here are the matching styles I found.";
        changed = true;
        logs.push("removed_clarifying_chips_from_product_turn");
      }
    }
  }

  return { text: nextText, changed, logs, contract: denialRepair.contract };
}

function sentenceSplit(text) {
  const decimalToken = "__DECIMAL_DOT__";
  const protectedText = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/(\d)\.(\d)/g, `$1${decimalToken}$2`);
  return (protectedText.match(/[^.!?]+[.!?]?/g) || [])
    .map((sentence) => sentence.replaceAll(decimalToken, "."));
}

function cardColors(card) {
  const values = [
    cardAttrValues(card, ["color", "colour", "Color", "Colour", "color_family", "Color Family", "color_fallback"]),
    card?.title,
  ];
  return new Set(flattenValues(values).map(normalizeKnownTextColor).filter(Boolean));
}

function titleSuffixColorName(title) {
  const match = String(title || "").match(/\s[-–—]\s*([^–—-]{2,48})$/);
  return match ? match[1].trim() : "";
}

function cardLiteralColorNames(card) {
  const facts = card?._variantFacts || card?.variantFacts || {};
  const titleColor = titleSuffixColorName(card?.title);
  if (titleColor) return [titleColor];
  const productColors = flattenValues(facts.productAvailableColors)
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (productColors.length > 0) return productColors;
  const values = [
    cardAttr(card, ["color", "colour", "color_family", "Color Family", "color_fallback"]),
  ];
  return flattenValues(values)
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

// Named shades that ARE the base color, not merely adjacent to it. This is
// the single source of truth for "this shade name literally IS color X" —
// deliberately narrow. Family-adjacency (coral→pink, terracotta→red,
// burgundy→red) is intentionally NOT here: those stay "similar/related" so
// "any pink?" never calls a Coral card pink. Add a shade here only when a
// shopper asking for the base color would unambiguously accept it.
const LITERAL_SHADE_IDENTITY = {
  purple: ["eggplant", "aubergine", "violet", "plum"],
};

function literalColorNameMatches(display, requestedColor) {
  const color = normalizeKnownTextColor(requestedColor);
  if (!color) return false;
  const value = String(display || "").toLowerCase().replace(/[_-]+/g, " ");
  const aliases = color === "gray" ? ["gray", "grey"] : [color];
  if (aliases.some((alias) => new RegExp(`\\b${escapeRegex(alias)}\\b`, "i").test(value))) {
    return true;
  }
  // A named shade that unambiguously IS the requested color (e.g. Eggplant
  // is purple) counts as a literal match; adjacent family colors do not.
  const shades = LITERAL_SHADE_IDENTITY[color] || [];
  return shades.some((shade) => new RegExp(`\\b${escapeRegex(shade)}\\b`, "i").test(value));
}

function cardMatchesLiteralColor(card, requestedColor) {
  return cardLiteralColorNames(card).some((name) => literalColorNameMatches(name, requestedColor));
}

function variantColorEntries(card) {
  const facts = card?._variantFacts || card?.variantFacts || {};
  const rawColors = [
    facts.availableColors,
    facts.colors,
    ...(Array.isArray(facts.byColor) ? facts.byColor.map((entry) => entry?.color) : []),
  ];
  const entries = [];
  const seen = new Set();
  for (const raw of flattenValues(rawColors)) {
    const display = String(raw || "").trim();
    const normalized = normalizeKnownTextColor(display);
    if (!display || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    entries.push({ display, normalized });
  }
  return entries;
}

function formatDisplayList(items) {
  const values = (Array.isArray(items) ? items : []).filter(Boolean);
  if (values.length <= 1) return values[0] || "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

const NEGATIVE_COLOR_AVAILABILITY_RE =
  /\b(?:only|just)\s+(?:comes?|available|offered|made|shown|stocked)?(?:\s+\w+){0,4}\s+in\s+[a-z][a-z\s-]{1,30}\b|\b(?:no|not any|none)\s+(?:other|additional|more)?\s*colou?rs?\b|\b(?:doesn'?t|does not|don'?t|do not|can'?t|cannot)\s+(?:come|offer|have|stock|carry|available)[^.!?]{0,100}\b(?:other|additional|more)?\s*colou?rs?\b/i;

function colorAvailabilityCorrection(cards, ctx = {}) {
  const requested = normalizeKnownTextColor(currentCatalogScopeFromContext(ctx).color);
  const corrections = [];
  const seen = new Set();

  for (const card of Array.isArray(cards) ? cards : []) {
    const colors = variantColorEntries(card);
    if (colors.length <= 1) continue;
    const otherColors = requested
      ? colors.filter((entry) => entry.normalized !== requested)
      : colors;
    if (otherColors.length === 0) continue;
    const key = `${card?.handle || card?.title || ""}:${otherColors.map((entry) => entry.normalized).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = String(card?.title || "This style").replace(/\s+-\s+[^-]+$/, "").trim();
    corrections.push(`${title} also comes in ${formatDisplayList(otherColors.map((entry) => entry.display))}.`);
  }

  return corrections.slice(0, 2).join(" ");
}

function hasNegativeColorAvailabilityClaim(sentence, cards) {
  const s = String(sentence || "");
  if (NEGATIVE_COLOR_AVAILABILITY_RE.test(s)) return true;
  if (!/\bonly\b/i.test(s)) return false;
  const colors = new Set();
  for (const card of Array.isArray(cards) ? cards : []) {
    for (const entry of variantColorEntries(card)) {
      colors.add(entry.display);
      colors.add(entry.normalized);
    }
  }
  for (const color of colors) {
    if (color && new RegExp(`\\b${escapeRegex(color)}\\b`, "i").test(s)) return true;
  }
  return false;
}

function repairColorAvailabilityClaims(text, cards, ctx = {}) {
  if (!text || !Array.isArray(cards) || cards.length === 0) return { text, changed: false };
  const correction = colorAvailabilityCorrection(cards, ctx);
  if (!correction) return { text, changed: false };

  let changed = false;
  const sentences = sentenceSplit(text)
    .map((sentence) => {
      const s = sentence.trim();
      if (!hasNegativeColorAvailabilityClaim(s, cards)) return s;
      changed = true;
      return correction;
    })
    .filter(Boolean);

  return {
    text: sentences.join(" ").replace(/\s{2,}/g, " ").trim(),
    changed,
  };
}

// Extract the set of normalized colors a sentence asserts, reusing the
// shared color vocabulary (single words + adjacent pairs like "navy
// blue" / "off white"). Used to verify positive availability claims.
function extractProseColors(sentence) {
  const words = String(sentence || "").toLowerCase().match(/[a-z]+/g) || [];
  const found = new Set();
  for (let i = 0; i < words.length; i++) {
    const single = normalizeKnownTextColor(words[i]);
    if (single) found.add(single);
    if (i + 1 < words.length) {
      const pair = normalizeKnownTextColor(`${words[i]} ${words[i + 1]}`);
      if (pair) found.add(pair);
    }
  }
  return [...found];
}

function cardTitleBase(card) {
  return String(card?.title || "").replace(/\s+[-–—]\s*[^-–—]+$/, "").trim();
}

// Raw color display names for a card (case + spelling preserved),
// including colors that don't map to the normalized vocabulary
// (e.g. "Terracotta", "Bronze"). variantColorEntries drops those, so
// it can't be used to RE-STATE a card's real colors — only to compare.
function cardRawColorDisplays(card) {
  const facts = card?._variantFacts || card?.variantFacts || {};
  const raw = [
    ...flattenValues([facts.availableColors]),
    ...flattenValues([facts.colors]),
    ...(Array.isArray(facts.byColor) ? facts.byColor.map((e) => e?.color) : []),
    ...flattenValues([facts.productAvailableColors]),
  ];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const display = String(r || "").trim();
    if (!display) continue;
    const key = display.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(display);
  }
  return out;
}

// Positive color over-claim verifier. The LLM sometimes free-texts a
// per-product color list ("Charlotte ... also comes in red, white,
// tan, blue, yellow, and black") that contradicts the product's actual
// variants. The negative-claim repair above only catches "only comes
// in X" denials. This catches the inverse: a sentence that names a
// specific card and asserts colors that card does NOT carry. We
// replace the offending sentence with the card's real colors (the same
// variant facts the rest of the system already trusts).
//
// Conservative by design — only fires when ALL of these hold:
//   - the sentence has a positive "(also) comes/available/offered in"
//     cue (we never touch non-color prose),
//   - it names a specific card from the pool (title base match),
//   - that card has at least one known variant color (facts present),
//   - the sentence asserts >=2 colors AND at least one is provably
//     absent from the card's real colors.
// When facts are missing or the claim is accurate, we leave it alone.
const POSITIVE_COLOR_CLAIM_RE =
  /\b(?:also\s+)?(?:comes?|is\s+available|are\s+available|available|offered|come)\s+(?:in|with)\b/i;

function repairPositiveColorClaims(text, cards) {
  if (!text || !Array.isArray(cards) || cards.length === 0) return { text, changed: false };
  let changed = false;
  const sentences = sentenceSplit(text)
    .map((sentence) => {
      const s = sentence.trim();
      if (!s || !POSITIVE_COLOR_CLAIM_RE.test(s)) return s;
      const sLower = s.toLowerCase();
      const named = cards.find((c) => {
        const base = cardTitleBase(c).toLowerCase();
        if (base.length >= 5 && sLower.includes(base)) return true;
        // Also accept the product's family name (first significant
        // word of the base, length >= 4 to skip "the", "a", etc.).
        // Real prose often abbreviates "Jillian Braided Quarter Strap
        // Sandal" to just "Jillian".
        const family = base.split(/\s+/)[0] || "";
        return family.length >= 4 && new RegExp(`\\b${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s);
      });
      if (!named) return s;
      const realNorm = new Set(variantColorEntries(named).map((e) => e.normalized));
      if (realNorm.size === 0) return s; // no normalizable facts → can't verify
      const realDisplays = cardRawColorDisplays(named);
      if (realDisplays.length === 0) return s; // no facts to re-state
      const claimed = extractProseColors(s);
      if (claimed.length < 2) return s; // not an enumeration
      const overclaimed = claimed.some((c) => !realNorm.has(c));
      // Two failure modes are both contradicts-self:
      //   (a) Overclaimed — the LLM named a color the product doesn't
      //       actually carry (e.g. Charlotte "comes in red" when it's
      //       terracotta-only).
      //   (b) Range-vs-variant mismatch — the LLM listed the product's
      //       full real color range while the displayed card is just
      //       one specific variant (e.g. Jillian displayed in Snake,
      //       prose says "comes in Navy, Cognac, White, Ivory, …").
      //       Real customers see the variant card and the prose
      //       contradicts it. Cap the enumeration to ~4 colors and
      //       include the displayed one explicitly so the prose
      //       matches what they see.
      const displayedColor = String(named?._attributes?.Color ||
                                    named?._attributes?.color ||
                                    titleSuffixColorName(named?.title) || "").trim();
      const rangeVsVariant = !overclaimed && claimed.length > 4;
      if (!overclaimed && !rangeVsVariant) return s;
      changed = true;
      const base = cardTitleBase(named) || "This style";
      // Surface up to 4 colors; prepend the displayed variant if it's
      // known and would otherwise be buried/missing.
      let toShow = realDisplays.slice();
      if (displayedColor) {
        const idx = toShow.findIndex((d) => d.toLowerCase() === displayedColor.toLowerCase());
        if (idx > 0) {
          toShow = [toShow[idx], ...toShow.slice(0, idx), ...toShow.slice(idx + 1)];
        } else if (idx < 0) {
          toShow = [displayedColor, ...toShow];
        }
      }
      const capped = toShow.slice(0, 4);
      const more = toShow.length > capped.length ? ` and ${toShow.length - capped.length} more` : "";
      return `${base} comes in ${formatDisplayList(capped)}${more}.`;
    })
    .filter(Boolean);
  return {
    text: sentences.join(" ").replace(/\s{2,}/g, " ").trim(),
    changed,
  };
}

// "Danika comes in X. Carly comes in Y." — but the displayed pool also
// includes Ivy / Charlotte / Blake. The bot enumerated a SUBSET of the
// cards, so the prose looks inconsistent with what the customer sees
// below. When that happens, replace the partial enumeration with a
// single neutral line — the cards already display each product's name
// and colors, no enumeration needed.
//
// =====================================================================
// Claim verifier — single accuracy-checking path for visible text
// =====================================================================
// Reads the per-card facts attached by chat-tools (`_conditionTags`,
// `_useCaseTags`, `_onSale`, `_removableInsole`) and verifies any
// product-text claims the AI emits against them.
//
// Three claim shapes are handled:
//   1. Universal-quantifier feature claims ("all of these are tagged
//      for plantar fasciitis", "both have arch support", "every pair
//      is on sale"). Verified against EVERY card; soften to "some of
//      these" when any card lacks the claimed feature.
//   2. Sale claims ("currently on sale", "both discounted"). Strip
//      the sale clause when none of the displayed cards is `_onSale`.
//   3. Unverifiable feature claims ("hiking", "travel", "waterproof",
//      "roomy toe box", "wide toe box", "rocker bottom", "orthotic-
//      compatible"). Strip the claim when no displayed card has the
//      corresponding structured tag (or when the catalog has no
//      structured field for the concept at all).
//
// Per-card claims (e.g. "the Maui is great for bunions") are left
// alone unless they make a universal assertion across the pool.
// The AI is allowed to be specific about a single product when the
// fact is present on that card.

// Map AI-text feature words to the canonical card-fact tag we'd
// check against. When the value is null, the claim is structurally
// unverifiable in this catalog and must be stripped.
const CLAIM_FEATURE_TO_FACT = {
  // ConditionTags
  "plantar fasciitis": { kind: "condition", tag: "plantar_fasciitis" },
  "bunion": { kind: "condition", tag: "bunions" },
  "bunions": { kind: "condition", tag: "bunions" },
  "flat feet": { kind: "condition", tag: "flat_feet" },
  "high arch": { kind: "condition", tag: "high_arch" },
  "high arches": { kind: "condition", tag: "high_arch" },
  "metatarsalgia": { kind: "condition", tag: "metatarsalgia" },
  "ball of foot pain": { kind: "condition", tag: "metatarsalgia" },
  "ball-of-foot pain": { kind: "condition", tag: "metatarsalgia" },
  "morton's neuroma": { kind: "condition", tag: "mortons_neuroma" },
  "mortons neuroma": { kind: "condition", tag: "mortons_neuroma" },
  "diabetic": { kind: "condition", tag: "diabetic" },
  "arthritis": { kind: "condition", tag: "arthritis" },
  "heel spur": { kind: "condition", tag: "heel_spur" },
  "heel spurs": { kind: "condition", tag: "heel_spur" },
  // UseCases
  "walking": { kind: "useCase", tag: "walking" },
  "running": { kind: "useCase", tag: "running" },
  "hiking": { kind: "useCase", tag: "hiking" },
  "trail": { kind: "useCase", tag: "hiking" },
  "trails": { kind: "useCase", tag: "hiking" },
  "travel": { kind: "useCase", tag: "travel" },
  "vacation": { kind: "useCase", tag: "travel" },
  "trip": { kind: "useCase", tag: "travel" },
  "beach": { kind: "useCase", tag: "beach" },
  "winter": { kind: "useCase", tag: "winter" },
  "athletic": { kind: "useCase", tag: "athletic" },
  "gym": { kind: "useCase", tag: "athletic" },
  "standing all day": { kind: "useCase", tag: "standing_all_day" },
  "on your feet all day": { kind: "useCase", tag: "standing_all_day" },
  // Catalog has NO structured field for these; never claim.
  "waterproof": { kind: "absent" },
  "water-resistant": { kind: "absent" },
  "roomy toe box": { kind: "absent" },
  "wide toe box": { kind: "absent" },
  "rocker bottom": { kind: "absent" },
  "orthotic-compatible": { kind: "absent" },
  "orthotic compatible": { kind: "absent" },
  // Water-friendly — distinct from "waterproof". Aetrex actually
  // uses this phrasing on ~7.6% of descriptions per the audit.
  // Verifier requires at least one displayed card to have
  // _waterFriendly=true (set conservatively from explicit
  // description match in chat-tools).
  "water-friendly": { kind: "waterFriendly" },
  "water friendly": { kind: "waterFriendly" },
  // Removable insole — boolean check
  "removable insole": { kind: "removableInsole" },
  // Arch support — `_archSupport` boolean per card. Aetrex's
  // built-in arch support is described as universal but we still
  // verify per-card so a non-arch-support product (rare) doesn't
  // get carried by a universal claim.
  "arch support": { kind: "archSupport" },
  // Sale — `_onSale` boolean. Bare per-product sale claims ("this
  // is on sale", "currently discounted") are verified just like
  // universal ones.
  "on sale": { kind: "onSale" },
  "currently discounted": { kind: "onSale" },
  "marked down": { kind: "onSale" },
  "discounted": { kind: "onSale" },
  // Footbed claims — verified against the merchant's `footbed`
  // attribute when populated. Passes through when no card has data.
  "memory foam footbed": { kind: "footbedSubstring", substring: "memory" },
  "memory-foam footbed": { kind: "footbedSubstring", substring: "memory" },
  "cushioned footbed": { kind: "footbedSubstring", substring: "cushion" },
  "orthotic footbed": { kind: "footbedSubstring", substring: "orthotic" },
  // Badge claims — verified against the merchant's `badge` attribute.
  // Specific phrasings only (not bare "new"); broad words false-
  // positive on legitimate marketing copy.
  "best seller": { kind: "badgeSubstring", substring: "best" },
  "bestseller": { kind: "badgeSubstring", substring: "best" },
  "best-seller": { kind: "badgeSubstring", substring: "best" },
};

// Universal quantifier phrasing: "all/every/both/each X have/are <feature>"
const UNIVERSAL_QUANTIFIER_RE =
  /\b(all|every|both|each)\b\s+(?:of\s+(?:these|those|them)\s+)?(?:\w+\s+){0,4}?(?:are|have|come(?:s)?|feature|features|support|supports|include(?:s)?|offer(?:s)?|tagged|built|made|designed)\b/i;

function cardHasFeature(card, claim) {
  if (!card || !claim) return false;
  if (claim.kind === "absent") return false;
  if (claim.kind === "condition") {
    const arr = card._conditionTags || [];
    return Array.isArray(arr) && arr.includes(claim.tag);
  }
  if (claim.kind === "useCase") {
    const arr = card._useCaseTags || [];
    return Array.isArray(arr) && arr.includes(claim.tag);
  }
  if (claim.kind === "removableInsole") {
    return card._removableInsole === true;
  }
  if (claim.kind === "archSupport") {
    return card._archSupport === true;
  }
  if (claim.kind === "waterFriendly") {
    return card._waterFriendly === true;
  }
  if (claim.kind === "onSale") {
    return card._onSale === true;
  }
  if (claim.kind === "footbedSubstring") {
    return typeof card._footbed === "string" && card._footbed.includes(claim.substring);
  }
  if (claim.kind === "badgeSubstring") {
    return typeof card._badge === "string" && card._badge.includes(claim.substring);
  }
  return false;
}

function poolSupportsClaim(cards, claim, { universal = false } = {}) {
  if (!Array.isArray(cards) || cards.length === 0) return false;
  if (claim.kind === "absent") return false;

  // For nullable string-field claims (footbed / badge), pass the
  // claim through when NO card in the pool has that field configured
  // — we shouldn't penalize a claim against a merchant attribute
  // that's simply not in use. When ANY card has data, judge only
  // those cards (the others are unknowns, not denials).
  if (claim.kind === "footbedSubstring" || claim.kind === "badgeSubstring") {
    const key = claim.kind === "footbedSubstring" ? "_footbed" : "_badge";
    const populated = cards.filter((c) => c?.[key] != null);
    if (populated.length === 0) return true;
    return universal
      ? populated.every((c) => cardHasFeature(c, claim))
      : populated.some((c) => cardHasFeature(c, claim));
  }

  if (universal) {
    return cards.every((c) => cardHasFeature(c, claim));
  }
  return cards.some((c) => cardHasFeature(c, claim));
}

// Iterate sentences in the AI text. For each, look for feature words
// from CLAIM_FEATURE_TO_FACT. If the sentence ALSO contains a
// universal quantifier, the claim must hold across every card.
// Otherwise it's a single-product or general statement, and as long
// as ANY card supports it (or the concept is structurally claimable)
// it stays.
//
// On failure:
//   - "absent" concepts (waterproof, roomy toe box, rocker bottom,
//     orthotic-compatible) → drop the whole sentence.
//   - Universal-failure conditions → drop the sentence.
//   - Universal-failure use-cases that the catalog COULD verify but
//     no card matches → drop the sentence.
//
// Sentence drop is preferred over surgical word edits because a
// broken half-sentence reads worse than a missing line.
// Surface the per-card proof that the verifier consulted when it
// dropped a sentence. Helps tell apart "the catalog genuinely has
// no card supporting this" from "a card-emit path is dropping
// provenance before the verifier sees it". Per-card line so the
// log reads like:
//   [response-contract] missing proof: claim=archSupport phrase=arch support universal=true
//     card="Maui Charcoal" handle=maui-charcoal cat=sneakers checked=title_description_scan,footbed_attribute,brand_rule_footwear_category
//     archSupport.value=false archSupport.source=none
// One log line per card, capped at 3 cards to avoid runaway noise.
//
// Map verifier claim.kind onto the canonical fact-bag key. Without
// this, lookups like facts["condition"] miss the fact stored at
// facts["conditionTags"] and the log lies "(no _claimFacts on
// card)" even when _claimFacts is present. See live failure
// 2026-06-02 17:52:48 for the symptom.
const CLAIM_KIND_TO_FACT_KEY = {
  condition: "conditionTags",
  useCase: "useCaseTags",
  archSupport: "archSupport",
  waterFriendly: "waterFriendly",
  onSale: "onSale",
  removableInsole: "removableInsole",
  footbedSubstring: "footbed",
  badgeSubstring: "badge",
};

function logMissingProof({ claim, sentence, pool }) {
  const phrase = claim?.phrase || "?";
  const kind = claim?.claim?.kind || "?";
  const factKey = CLAIM_KIND_TO_FACT_KEY[kind] || kind;
  const universal = !!claim?.universal;
  const checked = claimSourcesChecked(kind, pool?.[0] || {}).join(",") || "(no-facts-attached)";
  const sentencePreview = String(sentence || "").slice(0, 100).replace(/\s+/g, " ");
  console.warn(
    `[response-contract] missing proof: claim=${kind} phrase="${phrase}" universal=${universal} ` +
      `checked=${checked} sentence="${sentencePreview}"`,
  );
  const sample = Array.isArray(pool) ? pool.slice(0, 3) : [];
  for (const card of sample) {
    const facts = card?._claimFacts || null;
    const factEntry = facts ? facts[factKey] : null;
    const factValue = factEntry ? JSON.stringify(factEntry.value) : "(no _claimFacts on card)";
    const factSource = factEntry ? factEntry.source : "(none)";
    const title = String(card?.title || "?").slice(0, 60);
    const handle = card?.handle || "?";
    const cat = card?._claimFacts?.category?.value || card?._category || "?";
    console.warn(
      `  card="${title}" handle=${handle} cat=${cat} ` +
        `${kind}.value=${factValue} ${kind}.source=${factSource}`,
    );
  }
}

export function verifyClaimsAgainstCards({ text, cards } = {}) {
  const input = String(text || "");
  if (!input.trim()) return { text: input, changed: false, logs: [] };
  const pool = Array.isArray(cards) ? cards : [];

  // No facts available to verify against — leave the text alone
  // (degrades to legacy behavior for tests that don't pass cards).
  const haveAnyFacts = pool.some(
    (c) =>
      c && (
        Array.isArray(c._conditionTags) ||
        Array.isArray(c._useCaseTags) ||
        typeof c._onSale === "boolean" ||
        typeof c._archSupport === "boolean" ||
        typeof c._waterFriendly === "boolean" ||
        typeof c._footbed === "string" ||
        typeof c._badge === "string" ||
        typeof c._productLine === "string"
      ),
  );
  if (!haveAnyFacts) {
    // Observability — when a non-empty pool reaches the verifier
    // without fact fields, some upstream card path bypassed
    // extractProductCards. Surface that as a warning so future
    // regressions are visible without changing behavior.
    if (pool.length > 0) {
      console.warn(
        `[response-contract] verifier no-op: pool=${pool.length} but no card carries verifier facts ` +
          `— a card-emit path is bypassing extractProductCards`,
      );
    }
    return { text: input, changed: false, logs: [] };
  }

  const sentences = input.split(/(?<=[.!?])\s+/);
  const out = [];
  const logs = [];

  for (const s of sentences) {
    const lower = s.toLowerCase();
    let drop = false;
    let reason = null;
    let droppedClaim = null;

    // Feature claim verification — single generic loop. Sale claims
    // (universal AND per-product), arch support, conditions, use-
    // cases, footbed, and badge all flow through the same code path
    // via CLAIM_FEATURE_TO_FACT.
    {
      const universal = UNIVERSAL_QUANTIFIER_RE.test(s);
      // Find the first feature word present in the sentence.
      for (const [phrase, claim] of Object.entries(CLAIM_FEATURE_TO_FACT)) {
        if (!lower.includes(phrase)) continue;
        if (claim.kind === "absent") {
          drop = true;
          reason = `unverifiable_feature:${phrase}`;
          droppedClaim = { phrase, claim, universal };
          break;
        }
        const supported = poolSupportsClaim(pool, claim, { universal });
        if (!supported) {
          drop = true;
          reason = universal
            ? `unverified_universal:${phrase}`
            : `unverified_feature:${phrase}`;
          droppedClaim = { phrase, claim, universal };
          break;
        }
      }
    }

    if (drop) {
      logs.push(reason);
      // Missing-proof log — surface card title/handle/category and
      // the fact-sources the canonical builder consulted, so the
      // next defender can tell "no card had the tag" from "every
      // card had the tag but the builder lost provenance". Skipped
      // for "absent" claims (catalog literally has no field).
      if (droppedClaim && droppedClaim.claim.kind !== "absent") {
        logMissingProof({ claim: droppedClaim, sentence: s, pool });
      }
      continue;
    }
    out.push(s);
  }

  const next = out.join(" ").replace(/\s{2,}/g, " ").trim();

  // Catastrophic-strip guard. If verification would gut a SUBSTANTIAL answer
  // down to a fragment (or nothing), DON'T — keep the original. A zeroed or
  // fragmented reply ships the customer cards with no real answer (or a
  // generic "Take a look" non-answer), which is strictly worse than letting
  // the text through. On the LLM-owns path the grounding validator
  // (reject-and-retry) is the AUTHORITATIVE feature-claim check and has
  // already vetted this text; this verifier is a secondary net and must not
  // silently destroy a real answer over a merchant-specific fact-field miss
  // (prod: "which boots have memory foam?" → catalog stores footbed="ll"
  // warehouse code → verifier zeroed 172 chars → customer saw cards, no
  // answer). Partial strips that leave a usable reply are still applied.
  const SUBSTANTIAL_INPUT = 120;
  const FRAGMENT_OUTPUT = 60;
  if (input.trim().length >= SUBSTANTIAL_INPUT && next.length < FRAGMENT_OUTPUT) {
    console.warn(
      `[response-contract] verifier catastrophic-strip averted: ` +
        `${input.trim().length}→${next.length} chars would gut the reply; keeping original ` +
        `(reasons=${logs.join("+")})`,
    );
    return { text: input.trim(), changed: false, logs };
  }

  // Observability — over-strip warning. When the verifier removes
  // ≥50% of the AI's text length, the listing-template fallback
  // (`ensureCompleteCustomerText`) typically swaps in a generic
  // line, which hides the issue. Log so future regressions in
  // sentence-drop aggressiveness are visible.
  if (next.length > 0 && input.trim().length > 0) {
    const ratio = next.length / input.trim().length;
    if (ratio <= 0.5) {
      console.warn(
        `[response-contract] verifier over-strip: ${input.trim().length}→${next.length} chars ` +
          `(${Math.round((1 - ratio) * 100)}% removed) reasons=${logs.join("+")}`,
      );
    }
  }

  // Zeroed-text warning — the verifier dropped every sentence. The
  // emit-side fallback (`ensureCompleteCustomerText` with a pool>0
  // fallback line) must catch this, otherwise the customer sees
  // textLen=0 with cards. Log so we can correlate against emit logs.
  if (next.length === 0 && input.trim().length > 0) {
    console.warn(
      `[response-contract] verifier zeroed text: input=${input.trim().length} chars ` +
        `pool=${pool.length} reasons=${logs.join("+")}`,
    );
  }

  return {
    text: next,
    changed: next !== input.trim(),
    logs,
  };
}

// Conservative gating: must be a multi-card pool (≥3) AND the prose
// must name 2-N-1 distinct cards via the "comes in" pattern AND at
// least one displayed card must be UNNAMED in the prose. Anything
// outside that shape is left alone (no false positives on legitimate
// "X is a great pick" framing).
function collapsePartialPerProductEnumeration(text, cards) {
  if (!text || !Array.isArray(cards) || cards.length < 3) return { text, changed: false };
  const sentences = sentenceSplit(text);
  const enumSentences = [];
  const namedSet = new Set();
  const sLower = (s) => String(s || "").toLowerCase();
  for (const raw of sentences) {
    const s = String(raw || "").trim();
    if (!s || !POSITIVE_COLOR_CLAIM_RE.test(s)) continue;
    // Which card(s) does this sentence name?
    for (const c of cards) {
      const base = cardTitleBase(c).toLowerCase();
      const family = (base.split(/\s+/)[0] || "");
      const matchedBase = base.length >= 5 && sLower(s).includes(base);
      const matchedFamily =
        family.length >= 4 &&
        new RegExp(`\\b${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s);
      if (matchedBase || matchedFamily) {
        namedSet.add(c.handle || c.title);
        enumSentences.push(raw);
      }
    }
  }
  if (namedSet.size < 2) return { text, changed: false };
  if (namedSet.size >= cards.length) return { text, changed: false }; // covers all → fine
  // Build replacement: drop all the partial-enum sentences; if nothing
  // else remains, fall back to a neutral line that points at the cards.
  const enumSet = new Set(enumSentences);
  const kept = sentences.filter((s) => !enumSet.has(s)).map((s) => s.trim()).filter(Boolean);
  let replacement;
  if (kept.length > 0) {
    replacement = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  } else {
    replacement = `Here are the ${cards.length} styles I found — colors and details are on each card.`;
  }
  if (replacement.trim() === String(text).trim()) return { text, changed: false };
  return { text: replacement, changed: true };
}

function repairColorRangePromises(text, cards, ctx = {}) {
  if (!text || !Array.isArray(cards) || cards.length === 0) return { text, changed: false };
  const correction = colorAvailabilityCorrection(cards, ctx);
  if (!correction) return { text, changed: false };

  const talksAboutColorRange = /\b(?:colou?rs?|colorways?|colourways?|range of|available for each|what'?s available|comes? in)\b/i.test(text);
  if (!talksAboutColorRange) return { text, changed: false };

  const requested = normalizeKnownTextColor(currentCatalogScopeFromContext(ctx).color);
  const nonRequestedColors = new Set();
  for (const card of cards) {
    for (const entry of variantColorEntries(card)) {
      if (!requested || entry.normalized !== requested) {
        nonRequestedColors.add(entry.display);
        nonRequestedColors.add(entry.normalized);
      }
    }
  }
  for (const color of nonRequestedColors) {
    if (color && new RegExp(`\\b${escapeRegex(color)}\\b`, "i").test(text)) {
      return { text, changed: false };
    }
  }

  const next = `${text.replace(/\s+$/, "")} ${correction}`.replace(/\s{2,}/g, " ").trim();
  return { text: next, changed: next !== text };
}

function normalizeKnownTextColor(value) {
  const normalized = normalizeColor(value);
  if (normalized) return normalized;
  if (/\beggplant\b/i.test(String(value || ""))) return "purple";
  return null;
}

const DIRECT_PRODUCT_FACT_RE =
  /\b(?:what|which)\s+(?:colou?rs?|colorways?|sizes?|widths?|materials?|price|prices)\b|\b(?:other|more|different)\s+colou?rs?\b|\b(?:come|comes)\s+in\b|\b(?:available|in\s+stock)\s+(?:in\s+)?(?:size|width|\d)|\b(?:do|does|can|are|is)\s+(?:it|this|that|they|these|those|the\s+[\w'-]+)[^?]{0,90}\b(?:colou?rs?|colorways?|sizes?|widths?|wide|narrow|available|in\s+stock|waterproof|material|price)\b/i;

export function isDirectProductFactQuestion(message = "") {
  const text = String(message || "").trim();
  if (!text) return false;
  return DIRECT_PRODUCT_FACT_RE.test(text);
}

// Meta-conversational and stale-color detection both live in
// turn-intent.server.js now; response-contract reads the resolved
// signal off `ctx.sessionMemory.latestTurnIntent` rather than
// re-deriving from text. The previous regexes (META_CONVERSATIONAL_RE,
// YES_NO_INVERTED_RE, YES_NO_NON_INVERTED_RE, COLOR_VOCAB_RE) and the
// helpers `isMetaOrFactConversationalTurn` / `customerMentionsColorThisTurn`
// were removed as part of that consolidation.

function cardGender(card) {
  return normalizeGender(card?._gender) ||
    normalizeGender(cardAttr(card, ["gender", "gender_fallback", "genders"]));
}

function cardCategory(card) {
  return normalizeCategory(card?._category) ||
    normalizeCategory(card?.productType) ||
    normalizeCategory(cardAttr(card, ["category", "category_for_filter", "subcategory", "product_type"]));
}

function allCardsMatch(cards = [], predicate) {
  return Array.isArray(cards) && cards.length > 0 && cards.every(predicate);
}

function displayGender(value) {
  const gender = normalizeGender(value);
  if (gender === "men") return "men's";
  if (gender === "women") return "women's";
  if (gender === "kids") return "kids'";
  if (gender === "unisex") return "unisex";
  return "";
}

function displayCategory(value) {
  const category = normalizeCategory(value);
  if (!category) return "";
  if (category === "wedges-heels") return "wedges and heels";
  if (category === "slip-ons") return "slip-ons";
  if (category === "mary-janes") return "Mary Janes";
  return category.replace(/-/g, " ");
}

function scopedLabel(scope = {}, fallback = "styles") {
  const parts = [displayGender(scope.gender), displayCategory(scope.category)].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : fallback;
}

// Does the catalog actually carry this gender+category? Uses ctx.category-
// GenderMap ({ [category]: { genders: [...] } }). "footwear"/"shoes" is an
// UMBRELLA, not a leaf category — true when the catalog has ANY real
// footwear category (not orthotics/accessories) for the gender. Used to
// suppress a false "we don't carry [gender] [category]" denial when the
// scope genuinely exists (the orthotic resolver wrongly marks footwear
// impossible).
function genderCategoryExistsInCatalog(ctx, gender, category) {
  const map = ctx?.categoryGenderMap;
  const g = String(gender || "").toLowerCase().trim();
  const c = String(category || "").toLowerCase().trim();
  // Gender is OPTIONAL here. The customer often names a category with no
  // gender ("what shoes have worked for arch pain?"); denying it because we
  // can't pin a gender is a provably-false denial (prod trace 2026-06-25:
  // "my arches ache on long walks, what's worked for people my age" — gender
  // unstated — got "I couldn't find footwear in our current catalog"). Only a
  // category is required to do the existence check.
  if (!map || typeof map !== "object" || !c) return false;
  const hasGenderFor = (catKey) => {
    const entry = map[catKey];
    if (!entry || !Array.isArray(entry.genders) || entry.genders.length === 0) return false;
    // No gender stated → the category exists if it exists for ANY gender.
    if (!g) return true;
    return entry.genders.map((x) => String(x).toLowerCase()).some((x) => x === g || x === "unisex");
  };
  const FOOTWEAR_UMBRELLA = new Set(["footwear", "shoes", "shoe"]);
  const NON_FOOTWEAR = new Set(["orthotics", "orthotic", "insoles", "insole", "accessories", "accessory"]);
  if (FOOTWEAR_UMBRELLA.has(c)) {
    return Object.keys(map).some((k) => !NON_FOOTWEAR.has(String(k).toLowerCase()) && hasGenderFor(k));
  }
  return hasGenderFor(c) || hasGenderFor(c.replace(/s$/, "")) || hasGenderFor(`${c}s`);
}

export function buildCodeOwnedExactNoMatchText({ ctx = {} } = {}) {
  // Orthotic turns own their OWN no-match handling — the recommender either
  // asks for the next attribute or resolves a SKU. A generic "I couldn't find
  // <X> in our current catalog" denial here is always the wrong layer, and
  // recurringly WRONG: the resolver mis-infers a category from a clinical word
  // ("arch and heel PAIN" → category=wedges-heels), then a gender contradiction
  // flips men→women→men, and this scrubber ships "I couldn't find men's"
  // (prod trace 2026-06-25). Never deny on an orthotic-scoped turn — let the
  // orthotic flow / recommender drive.
  if (ctx?.classifiedIntent?.isOrthoticRequest === true) {
    return { text: "", reason: "orthotic_turn_owns_no_match" };
  }
  const resolver = ctx?.resolverState;
  const impossible = Array.isArray(resolver?.impossible_constraints)
    ? resolver.impossible_constraints
    : [];
  // Only a HARD catalog facet that genuinely doesn't exist — color,
  // gender, or category — warrants a "we don't carry that" denial. A
  // no_match on a SOFT orthotic attribute (useCase/condition/arch/posted/
  // metSupport) means "no orthotic SKU matches that exact attribute
  // combo", NOT "we don't carry men's footwear". Phrasing the latter is
  // a provably-false denial (prod trace 2026-06-24: "insoles or shoes for
  // foot pain at work" → orthotic tree had no work_all_day SKU → bot said
  // "I couldn't find men's footwear" and never even searched). Deny only
  // on a hard-facet impossibility; otherwise fall through to search.
  const HARD_FACETS = new Set(["color", "gender", "category"]);
  const hardImpossible = impossible.filter((c) => HARD_FACETS.has(c?.field));
  if (hardImpossible.length === 0) {
    return { text: "", reason: "not_exact_no_match" };
  }

  const scope = currentCatalogScopeFromContext(ctx);
  const primary = hardImpossible[0] || {};
  const groupCategory = scope.category || ctx?.activeCategoryGroup?.name || "";

  // Catalog-reality guard. The ORTHOTIC resolver marks category="footwear"
  // (or gender) impossible because IT only knows orthotic SKUs — but the
  // catalog plainly carries men's footwear. Denying a gender+category that
  // actually exists is a provably-false statement (prod trace 2026-06-24:
  // "insoles or shoes for foot pain" walked the orthotic questionnaire then
  // ended on "I couldn't find men's footwear"). Only category/gender misses
  // are checkable here; a color miss ("no pink") is a real denial we keep.
  if (primary.field === "category" || primary.field === "gender") {
    const denyGender = primary.field === "gender" ? (primary.value || scope.gender) : scope.gender;
    const denyCategory =
      primary.field === "category" ? (primary.value || scope.category || groupCategory) : (scope.category || groupCategory);
    if (genderCategoryExistsInCatalog(ctx, denyGender, denyCategory)) {
      return { text: "", reason: "catalog_has_scope_not_denied" };
    }
  }

  let requested;
  if (primary.field === "color") {
    requested = [
      String(primary.value || scope.color || "").toLowerCase(),
      displayGender(scope.gender),
      displayCategory(groupCategory),
    ].filter(Boolean).join(" ");
  } else if (primary.field === "gender") {
    requested = [
      displayGender(primary.value || scope.gender),
      displayCategory(scope.category || groupCategory),
    ].filter(Boolean).join(" ");
  } else if (primary.field === "category") {
    requested = [
      displayGender(scope.gender),
      displayCategory(primary.value || scope.category),
    ].filter(Boolean).join(" ");
  } else {
    requested = scopedLabel(scope, "that exact combination");
  }

  const label = requested || "that exact combination";
  return {
    text: `I couldn't find ${label} in our current catalog. Try a different color or style?`,
    reason: "exact_catalog_no_match",
  };
}

function dominantCardValue(cards = [], getter) {
  const counts = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    const value = getter(card);
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  if (counts.size === 0) return "";
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function actualCardsLabel(cards = []) {
  const gender = dominantCardValue(cards, cardGender);
  const category = dominantCardValue(cards, cardCategory);
  return scopedLabel({ gender, category }, "styles");
}

function impossibleScopeListingText(cards = [], ctx = {}) {
  const impossible = Array.isArray(ctx?.resolverState?.impossible_constraints)
    ? ctx.resolverState.impossible_constraints
    : [];
  const structural = impossible.find((item) => item?.field === "gender" || item?.field === "category");
  if (!structural) return "";

  const scope = currentCatalogScopeFromContext(ctx);
  const requested = scopedLabel({
    gender: structural.field === "gender" ? structural.value : scope.gender,
    category: structural.field === "category" ? structural.value : scope.category,
  }, structural.field === "category" ? displayCategory(structural.value) || "that category" : "that style");
  const alternatives = actualCardsLabel(cards);

  if (cards.length > 0) {
    return `We don't carry ${requested} right now. Here are ${alternatives} as the closest alternatives.`;
  }
  return `We don't carry ${requested} right now. I can help look for another style.`;
}

function listingBaseLabel({ cards = [], ctx = {} } = {}) {
  const scope = currentCatalogScopeFromContext(ctx);
  const scopedGender = normalizeGender(scope.gender);
  const scopedCategory = normalizeCategory(scope.category);
  const dominantCategory = dominantCardValue(cards, cardCategory);
  const allSameDominantCategory = dominantCategory && allCardsMatch(cards, (card) => {
    const c = cardCategory(card);
    return !c || c === dominantCategory;
  });
  const gender = scopedGender && allCardsMatch(cards, (card) => {
    const g = cardGender(card);
    return !g || g === scopedGender || g === "unisex";
  })
    ? scopedGender
    : "";
  let category = scopedCategory && allCardsMatch(cards, (card) => {
    const c = cardCategory(card);
    return !c || c === scopedCategory;
  })
    ? scopedCategory
    : allSameDominantCategory
      ? dominantCategory
      : "";

  // Never return a bare possessive gender label ("women's") as the noun.
  // Recovery text may prepend color, producing broken copy like
  // "Here are the black women's I found." Use the scoped category when
  // available, otherwise fall back to a generic product noun.
  if (!category && gender) {
    const scopedCategoryLabel = displayCategory(scopedCategory);
    return scopedCategoryLabel
      ? `${displayGender(gender)} ${scopedCategoryLabel}`
      : `${displayGender(gender)} styles`;
  }

  const parts = [displayGender(gender), displayCategory(category)].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "styles";
}

function variantScopeLabel(scope = {}) {
  const variant = canonicalizeVariantConstraints(scope);
  const parts = [];
  if (variant.size) parts.push(`size ${variant.size}`);
  if (variant.width) parts.push(`${variant.width} width`);
  if (variant.sku && parts.length === 0) parts.push(`SKU ${variant.sku.toUpperCase()}`);
  return parts.length > 0 ? ` with ${formatDisplayList(parts)} available` : "";
}

function templateIndex(cards = [], base = "") {
  const seed = `${base}:${cards.map((card) => card?.handle || card?.title || "").join("|")}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash + seed.charCodeAt(i)) % 997;
  return hash % 3;
}

// Build a short, conversion-leaning fallback line that stays
// strictly inside facts we can prove from the displayed cards:
// count, category, sale ratio (if every card is on sale), and
// adjustable mention (when the title literally contains
// "adjustable"). Never invents medical/comfort/support claims —
// the verifier already strips those when AI prose makes them
// unsupported, so the fallback must NOT reintroduce them.
//
// 2026-06-02 spec request: replace the bland "Here are the matching
// styles I found." baseline with something a real concierge would
// say. Verified-only signals: count + category + sale callout +
// adjustability hint.
function sellerSpiritListingLine({ cards = [], base = "", variantText = "" } = {}) {
  const pool = Array.isArray(cards) ? cards : [];
  const n = pool.length;
  const baseLabel = (base || "styles").trim();
  if (n === 0) return `Here are the matching styles I found.`;

  const allOnSale = n > 0 && pool.every((c) => c?._onSale === true);
  const adjustableCount = pool.filter((c) =>
    /\badjust/i.test(String(c?.title || ""))
  ).length;
  const hasAdjustable = adjustableCount > 0 && adjustableCount < n;
  const allAdjustable = adjustableCount === n && n >= 2;

  let lead;
  if (n === 1) {
    lead = `I found one ${trimTrailingS(baseLabel)}${variantText} that fits your request.`;
  } else {
    lead = `I found ${n} ${baseLabel}${variantText} that match your request.`;
  }

  // Optional second sentence — only when a verified differentiator
  // exists. Otherwise close with a soft prompt to open cards.
  let hint;
  if (allOnSale) {
    hint = n === 1
      ? `It's currently on sale — open the card for size and color availability.`
      : `All of them are currently on sale — open a card to check size and color.`;
  } else if (allAdjustable) {
    hint = `They all have adjustable straps if you want easier fit control — open a card for size and color.`;
  } else if (hasAdjustable) {
    hint = `Start with the adjustable styles if you want easier fit control, then open a card to check size and color.`;
  } else {
    hint = `Open a card to check size and color availability.`;
  }

  return `${lead} ${hint}`.replace(/\s{2,}/g, " ").trim();
}

function trimTrailingS(s) {
  const t = String(s || "").trim();
  if (t.length > 3 && t.toLowerCase().endsWith("s")) return t.slice(0, -1);
  return t;
}

export function buildSoftBrowseFallbackText({ input = {}, hasProducts = true, repeated = false, repeatIndex = 0 } = {}) {
  if (!hasProducts) {
    return "No problem — we can browse first and narrow later. Tell me a style, color, or price range and I'll pull options.";
  }

  // Repeated browse: the customer asked for something different ("show
  // me something else", "more") after we already showed a starter mix.
  // Re-emitting the identical "here are a few styles…" line reads as a
  // stuck loop (the dominant adversarial-hunter "repetitive" seam).
  // Rotate through distinct phrasings so a customer who keeps saying
  // "something else" gets a different sentence each time, and the tone
  // moves from invitational to more direct nudging for a constraint.
  // Pairs with a rotated product set (priorlyShownHandles excludes
  // already-shown cards) so cards differ too.
  if (repeated) {
    // repeatIndex: 1 = first repeat, 2 = second, 3+ = nudge harder.
    const idx = Math.max(1, Number(repeatIndex) || 1);
    if (idx === 1) {
      return "Here's a different set to look through. To zero in faster, tell me a style (sneakers, sandals, boots, clogs), a color, or a price range — or whether it's men's or women's.";
    }
    if (idx === 2) {
      return "Here's another angle — a fresh mix. Anything jumping out? A category, a color, or a budget would help me narrow this down for you.";
    }
    return "I'll keep mixing it up, but I'm flying a bit blind. Even a rough hint — sneakers vs sandals, under $100, men's or women's — and I can pull a much tighter set.";
  }

  const query = String(input?.query || "").toLowerCase();
  const priceMax = Number(input?.priceMax);
  if (Number.isFinite(priceMax) && priceMax > 0) {
    return `Here are styles under $${Math.round(priceMax)} to start with. You can narrow by men's, women's, style, or color from here.`;
  }
  if (input?.onSale === true || /\bsale|deals?|discount|cheap\b/i.test(query)) {
    return "Here are sale styles to start with. You can narrow by men's, women's, style, color, or a specific budget from here.";
  }
  if (/\bpopular|best\s*sellers?|top\s+rated|favorite\b/i.test(query)) {
    return "Here are popular styles to start with. You can narrow by men's, women's, style, color, or price from here.";
  }
  if (/\barch|support|comfort|pain|standing|walking\b/i.test(query)) {
    return "Here are comfort-focused styles to start with. You can narrow by men's, women's, style, color, or price from here.";
  }
  return "No problem — here are a few styles to start with. You can narrow by men's, women's, style, color, or price from here.";
}

function publicPrice(card = {}) {
  return String(card.price_formatted || card.priceRange || card.price || "").trim();
}

function shortCardDescription(card = {}) {
  const bits = [];
  const category = displayCategory(cardCategory(card));
  const color = cardLiteralColorNames(card)[0] || "";
  const price = publicPrice(card);
  if (color) bits.push(color);
  if (category) bits.push(category);
  if (price) bits.push(price);
  return bits.length > 0 ? bits.join(", ") : "shown in the cards";
}

export function buildCodeOwnedComparisonText({ text = "", cards = [] } = {}) {
  const raw = Array.isArray(cards) ? cards.filter(Boolean) : [];
  // Same-base-style dedupe. The catalog stores color variants as
  // separate products ("Jillian Shimmer Blush" vs "Jillian Coral")
  // and the comparison prompt would otherwise treat them as
  // different styles — bot would invent feature differences
  // between cards that share every attribute except color. Group
  // by titleStyleFamily and keep only the first per family. See
  // 2026-06-02 prod: "Which of these has the most cushioning like
  // the Jillian?" compared two Jillian color variants as distinct.
  const seenFamily = new Set();
  const list = [];
  for (const c of raw) {
    const fam = titleStyleFamily(c?.title || "");
    if (fam && seenFamily.has(fam)) continue;
    if (fam) seenFamily.add(fam);
    list.push(c);
    if (list.length === 2) break;
  }
  if (list.length < 2) {
    // Every card was the same base style. Tell the customer plainly
    // instead of inventing a comparison that doesn't exist.
    if (raw.length >= 2) {
      const fam = titleStyleFamily(raw[0]?.title || "") || "style";
      const next =
        `These are all the same ${fam} style in different colors — the support, fit, and construction are identical. ` +
        `Pick whichever color you prefer.`;
      return {
        text: next.replace(/\s{2,}/g, " ").trim(),
        changed: next.trim() !== String(text || "").trim(),
        reason: "code_owned_comparison_same_family",
      };
    }
    return { text, changed: false, reason: "" };
  }
  const [a, b] = list;
  const next =
    `Quick comparison of the first two: **${a.title}** is ${shortCardDescription(a)}; ` +
    `**${b.title}** is ${shortCardDescription(b)}. Pick the first if that style feels closer, or the second if you prefer its look.`;
  return {
    text: next.replace(/\s{2,}/g, " ").trim(),
    changed: next.trim() !== String(text || "").trim(),
    reason: "code_owned_comparison",
  };
}

function exactRequestedColorMatches(cards = [], requestedColor) {
  const color = normalizeKnownTextColor(requestedColor);
  if (!color || !Array.isArray(cards) || cards.length === 0) {
    return { any: false, all: false, semanticAny: false, semanticAll: false };
  }
  const exactMatches = cards.filter((card) =>
    cardLiteralColorNames(card).some((name) => literalColorNameMatches(name, color)),
  ).length;
  const semanticMatches = cards.filter((card) => cardColors(card).has(color)).length;
  return {
    any: exactMatches > 0,
    all: exactMatches === cards.length,
    semanticAny: semanticMatches > 0,
    semanticAll: semanticMatches === cards.length,
  };
}

// Detect a numeric count claim in the AI's prose. Returns the
// largest plausible count found, or null. We look at three signals:
//   1. "both" / "both of these / them" → 2
//   2. "here are <N>" / "here's <N>" → N  (e.g. "Here are two ...")
//   3. "<N> options|styles|picks|matches|choices|products|pairs" → N
// Numerics or English number words one..ten count. Anything outside
// that range we ignore (probably not a card count — could be a year,
// size, etc.).
//
// We deliberately return the MAX because text like "Here are two
// great options... both currently on sale!" makes two claims and
// both should agree with the pool. Any disagreement is a mismatch.
const NUMBER_WORD_TO_INT = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
function parseCountToken(token) {
  if (!token) return null;
  const lower = String(token).toLowerCase();
  if (lower in NUMBER_WORD_TO_INT) return NUMBER_WORD_TO_INT[lower];
  const n = Number(lower);
  if (Number.isInteger(n) && n >= 1 && n <= 10) return n;
  return null;
}
function detectAiCountClaim(text) {
  const t = String(text || "").toLowerCase();
  const counts = new Set();

  if (/\bboth\b/.test(t)) counts.add(2);

  const re1 = /\bhere(?:'s|\s+(?:is|are))\s+(\w+)\s+(?:great\s+)?(?:option|options|pick|picks|style|styles|match|matches|choice|choices|product|products|pair|pairs|item|items)/gi;
  for (const m of t.matchAll(re1)) {
    const n = parseCountToken(m[1]);
    if (n !== null) counts.add(n);
  }

  const re2 = /\b(\w+)\s+(?:great\s+)?(?:option|options|pick|picks|style|styles|match|matches|choice|choices|product|products|pair|pairs|item|items)\b/gi;
  for (const m of t.matchAll(re2)) {
    const n = parseCountToken(m[1]);
    if (n !== null) counts.add(n);
  }

  if (counts.size === 0) return null;
  return Math.max(...counts);
}

export function buildCodeOwnedProductListingText({ text = "", cards = [], ctx = {}, recommenderInvoked = false } = {}) {
  if (!Array.isArray(cards) || cards.length === 0 || recommenderInvoked) {
    return { text, changed: false, reason: "" };
  }
  if (isDirectProductFactQuestion(ctx?.latestUserMessage)) {
    return { text, changed: false, reason: "direct_product_fact_question" };
  }
  // Review/return/fit-shaped follow-up — the LLM was actively trying
  // to answer a meta question about the products (which has the
  // highest review, do these run small, what's the return rate).
  // Replacing whatever answer it produced with a generic "I found N
  // sandals" listing is the worst possible move: it ignores the
  // actual question and looks robotic. Trust the LLM's text here.
  // Live trace 2026-06-08: "which one has the highest review?" got
  // LLM text scrubbed down to 3 chars, then response-contract
  // replaced it with the 92-char generic listing — the customer
  // never saw an answer.
  if (REVIEW_FIT_RETURN_SHAPE_RE.test(String(ctx?.latestUserMessage || ""))) {
    return { text, changed: false, reason: "review_fit_return_follow_up" };
  }
  // ONE shared intent signal — read what session-memory already
  // resolved for this turn instead of re-detecting in two places.
  // When the upstream signal isn't available (e.g. a legacy caller
  // that hasn't built session memory yet), behavior degrades to
  // the pre-consolidation default: scope.color drives the template
  // and no meta short-circuit fires.
  const turnIntent = ctx?.sessionMemory?.latestTurnIntent || null;
  const aiTextLen = String(text || "").trim().length;

  // Conversational / meta turn — customer is asking a yes/no fact
  // question about a specific product ("is tatiana your cheapest?"),
  // calling out the bot ("do you even understand?"), or asking the
  // bot to compare what's on screen. A substantive AI response
  // addresses that directly; overriding with a product-listing
  // template is the worst possible failure mode.
  if (turnIntent?.label === "meta" && aiTextLen >= 40) {
    return { text, changed: false, reason: "meta_conversational_turn" };
  }

  const scope = currentCatalogScopeFromContext(ctx);
  const base = listingBaseLabel({ cards, ctx });
  // requestedColor honors scope.color only when the customer touched
  // color THIS turn. Stale scope.color from prior turns shouldn't
  // dictate a "couldn't find exact white..." rewrite when this turn
  // is about price, sizing, or anything else. Source of truth: the
  // intent resolver's `extractedThisTurn` (what the customer literally
  // mentioned) and `reason` (whether the prior color was restated).
  const rawScopeColor = normalizeKnownTextColor(scope.color);
  const colorTouchedThisTurn = turnIntent
    ? Boolean(turnIntent.extractedThisTurn?.color) ||
      /color/i.test(turnIntent.reason || "")
    : true; // No intent signal → legacy behavior (treat as touched).
  const requestedColor = rawScopeColor && colorTouchedThisTurn ? rawScopeColor : null;
  const variantText = variantScopeLabel(scope);
  let next;

  const impossibleText = impossibleScopeListingText(cards, ctx);
  if (impossibleText) {
    return {
      text: impossibleText.replace(/\s{2,}/g, " ").trim(),
      changed: impossibleText.trim() !== String(text || "").trim(),
      reason: "impossible_scope_listing",
    };
  }

  // Trust the AI's text when it's already clean and helpful. The
  // listing replacer used to fire on EVERY product turn, gagging the
  // AI's natural framing ("These red sandals have arch support and
  // adjustable straps") into a robotic 30-char line ("Here are the red
  // women's sandals I found"). That's the regression that made the bot
  // feel dumb. Only replace when the AI's text is:
  //   (a) very short / empty (no real content), OR
  //   (b) wrong about a color the customer asked for (color-aware
  //       framing only), OR
  //   (c) lying about counts / scopes we can prove from the cards.
  // Otherwise the AI's prose ships unchanged. The other passes
  // (false-denial repair, color-claim verifier, narration strips) still
  // run independently and catch their own specific failures.
  const aiText = String(text || "").trim();
  const isUseful = aiText.length >= 60 && !/\b(let me|i'?ll|one moment|hold on)\b/i.test(aiText);
  const aiClaimsRequestedColor = requestedColor &&
    new RegExp(`\\b${requestedColor}\\b`, "i").test(aiText);

  // Count mismatch: AI's prose claims a specific number of products
  // ("Here are two great options... both currently on sale!") but the
  // actual card pool after upstream scope/color filtering is a
  // different size. Trust loses to truth — always override the prose
  // when the AI is lying about how many things are being shown.
  // Production trace: customer asked for red wedge heels; AI wrote a
  // two-product listing; color-enforcement filter dropped one card;
  // the screenshot landed with ONE card under prose still claiming
  // "two".
  const claimedCount = detectAiCountClaim(aiText);
  const countMismatch = claimedCount !== null && claimedCount !== cards.length;

  if (requestedColor) {
    const colorMatch = exactRequestedColorMatches(cards, requestedColor);
    // If the AI's text claims a NEGATIVE result ("couldn't find / no
    // exact / don't have / not in") for the requested color, but the
    // pool actually contains literal matches, the AI is wrong — always
    // replace with the truthful line. Production trace (R8e): cards had
    // Eggplant (= purple) but AI wrote "couldn't find purple".
    const aiClaimsNegative = isUseful && new RegExp(
      `(?:couldn'?t\\s+find|no\\s+exact|don'?t\\s+have|not\\s+in|cannot\\s+find|no\\s+\\w+\\s+(?:in\\s+)?${requestedColor})`,
      "i",
    ).test(aiText);
    if (colorMatch.all) {
      // AI's text already names the requested color correctly AND is
      // substantive AND doesn't deny the color AND doesn't lie about
      // the count → keep it. Otherwise replace with the honest line.
      if (isUseful && aiClaimsRequestedColor && !aiClaimsNegative && !countMismatch) {
        return { text: aiText, changed: false, reason: "ai_text_color_accurate" };
      }
      next = `Here are the ${requestedColor} ${base}${variantText} I found.`;
    } else if (colorMatch.any) {
      next = `Here are the ${requestedColor} and similar ${base}${variantText} I found.`;
    } else if (colorMatch.semanticAny) {
      next = `I couldn't find exact ${requestedColor} ${base}, but here are ${base}${variantText} in similar colors.`;
    } else {
      next = `I couldn't find ${requestedColor} ${base}, but here are ${base}${variantText} in other colors.`;
    }
  } else {
    // No color was requested — if the AI wrote substantive text without
    // narration leaks AND its count claims line up with the pool, trust
    // it. Otherwise replace empty / narration-only / count-lying text
    // with a neutral listing line.
    if (isUseful && !countMismatch) {
      return { text: aiText, changed: false, reason: "ai_text_kept" };
    }
    next = sellerSpiritListingLine({ cards, base, variantText });
  }

  return {
    text: next.replace(/\s{2,}/g, " ").trim(),
    changed: next.trim() !== String(text || "").trim(),
    reason: "code_owned_listing",
  };
}

export function ensureCompleteCustomerText({ text, fallback = "Here are the matching styles I found." } = {}) {
  let next = String(text || "").replace(/[ \t]{2,}/g, " ").trim();
  if (!next) return { text: fallback, changed: true, reason: "empty" };

  const danglingRe = /(?:,\s*)?\b(?:so|but|and|or|because|while|then|with|for|to|from|including|such as|the width options are|the options are|ways to save are)\s*[.!?]?$/i;
  const trailingListLeadRe = /(?:^|\s)(?:here are|including|such as|ways to save|options are|width options are)\s*[:—-]\s*$/i;
  if (!danglingRe.test(next) && !trailingListLeadRe.test(next)) {
    return { text: next, changed: false, reason: "" };
  }

  const sentences = sentenceSplit(next)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length > 1) {
    sentences.pop();
    const repaired = sentences.join(" ").trim();
    if (repaired.length >= 12) return { text: repaired, changed: true, reason: "trimmed_dangling_sentence" };
  }
  return { text: fallback, changed: true, reason: "fallback_after_dangling" };
}

export function repairProductResponseText({ text, pool = [], ctx = {}, relaxedFilters = null } = {}) {
  const contract = deriveProductResponseContract({ pool, ctx, relaxedFilters });
  if (!text || !contract.exactScopeSatisfied || !detectAiNoMatchPhrasing(text)) {
    return { text, changed: false, contract };
  }
  // RELAXED-FILTER HONESTY EXEMPTION.
  // exactScopeSatisfied means the broader scope (e.g. women's sandals)
  // was satisfied — but if the search had to RELAX a specific attribute
  // (e.g. customer asked for color=lapis lazuli, search dropped the
  // color filter to return any women's sandals), then the AI saying
  // "we don't have lapis lazuli sandals" is HONEST, not contradictory.
  // Stripping it leaves the customer with random sandals and no
  // explanation. Live trace 2026-06-10: customer asked for lapis lazuli
  // sandals, AI wrote 231 chars including honest denial + alternatives,
  // this stripper cut to 51 chars of "here are some top sandals to
  // browse" with no mention of color absence.
  // We also honor isLlmOwnsTurnEnabled: when the new grounding-validator
  // path is in charge, denial honesty is the explicit prompt rule and
  // this code-side stripper must not override it.
  if (relaxedFilters && Object.keys(relaxedFilters).length > 0) {
    return { text, changed: false, contract };
  }
  if (isLlmOwnsTurnActive()) {
    return { text, changed: false, contract };
  }

  const stripped = stripAvailabilityDenialSentences(text);
  return {
    text: detectAiNoMatchPhrasing(stripped)
      ? "Here are the matching styles I found."
      : stripped,
    changed: true,
    contract,
  };
}

// Lightweight check — same env-flag rule as
// app/lib/llm-owns-turn.server.js's isLlmOwnsTurnEnabled(), inlined
// here to avoid importing the orchestrator into the response-contract
// (would create a circular reference: chat.jsx → response-contract →
// llm-owns-turn → chat.jsx).
function isLlmOwnsTurnActive() {
  const raw = String(process.env.LLM_OWNS_ALL_TURNS || "").toLowerCase();
  if (raw === "false") return false;
  return true;
}

export function extractTurnChips(text) {
  const chips = [];
  const re = /<<\s*([^<>]+?)\s*>>/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const label = String(m[1] || "").trim();
    if (label) chips.push(label);
  }
  return chips;
}

export function createTurnResult({
  text = "",
  products = [],
  links = [],
  flags = {},
  ctx = {},
  diagnostics = {},
} = {}) {
  const normalizedProducts = Array.isArray(products) ? products.filter(Boolean) : [];
  let normalizedText = String(text || "").trim();
  if (
    normalizedProducts.length === 0 &&
    /\b(?:here are|take a look|check out|these are|i found|closest matches)\b/i.test(normalizedText)
  ) {
    normalizedText = flags.productSearchAttempted
      ? "I don't have a matching product card to show for that exact request. Try another size, width, color, or style and I'll check again."
      : "Tell me a bit more about what you're looking for and I'll narrow it down.";
  }
  const normalizedLinks = Array.isArray(links)
    ? links
        .filter((link) => link && typeof link === "object" && link.url)
        .map((link) => ({
          url: String(link.url || ""),
          label: String(link.label || ""),
        }))
    : [];

  return {
    type: "turn_result",
    version: 1,
    text: normalizedText,
    products: normalizedProducts,
    chips: extractTurnChips(normalizedText),
    links: normalizedLinks,
    scope: currentCatalogScopeFromContext(ctx),
    flags: {
      productSearchAttempted: !!flags.productSearchAttempted,
      recommenderInvoked: !!flags.recommenderInvoked,
      hasSupportCTA: !!flags.hasSupportCTA,
      hasGenericCTA: !!flags.hasGenericCTA,
      hasKlaviyoForm: !!flags.hasKlaviyoForm,
    },
    diagnostics,
  };
}

export function prepareProductCardsForTurn(cards = []) {
  const seen = new Set();
  const products = [];
  const categoryCounts = new Map();
  const genderCounts = new Map();

  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card) continue;
    const key = card.handle || card.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);

    if (card._category) {
      categoryCounts.set(card._category, (categoryCounts.get(card._category) || 0) + 1);
    }
    if (card._gender) {
      genderCounts.set(card._gender, (genderCounts.get(card._gender) || 0) + 1);
    }

    const publicCard = { ...card };
    delete publicCard._descriptionSnippet;
    delete publicCard._searchQuery;
    delete publicCard._category;
    delete publicCard._gender;
    delete publicCard._attributes;
    delete publicCard._variantFacts;
    products.push(publicCard);
  }

  return { products, categoryCounts, genderCounts };
}

function dominantFromCounts(counts) {
  if (!(counts instanceof Map) || counts.size === 0) return "";
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dominantRequestedColor(ctx = {}) {
  if (
    !Array.isArray(ctx._merchantColors) ||
    ctx._merchantColors.length === 0 ||
    typeof ctx.latestUserMessage !== "string"
  ) {
    return null;
  }
  const latest = ctx.latestUserMessage.toLowerCase();
  const sorted = [...ctx._merchantColors].sort((a, b) => b.length - a.length);
  for (const color of sorted) {
    if (new RegExp(`\\b${escapeRegex(color)}\\b`, "i").test(latest)) return color;
  }
  return null;
}

export function resolveProductTurnLink({ categoryCounts, genderCounts, ctx = {} } = {}) {
  const hasCategories = categoryCounts instanceof Map && categoryCounts.size > 0;
  const dominantCat = dominantFromCounts(categoryCounts);
  const dominantGender = dominantFromCounts(genderCounts) || ctx.sessionGender || "";

  if (
    (ctx.storefrontSearchUrlPattern || (Array.isArray(ctx.ctaOverrides) && ctx.ctaOverrides.length > 0)) &&
    hasCategories &&
    !ctx.categoryIntentAmbiguous
  ) {
    const latest = String(ctx.latestUserMessage || "").toLowerCase();
    const hasSpecificStyle = /\b(sneaker|sandal|boot|wedge|heel|loafer|flat|slip[- ]on|clog|mule|oxford|pump|trainer|moccasin|slipper|orthotic)/i.test(latest);
    const isGenericAsk = !hasSpecificStyle && /\b(shoes?|footwear|anything|something|options|recommend)/i.test(latest);
    const totalCards = [...categoryCounts.values()].reduce((a, b) => a + b, 0);
    const topShare = dominantCat && totalCards > 0 ? (categoryCounts.get(dominantCat) / totalCards) : 0;
    const mixedStyles = categoryCounts.size >= 3 || topShare < 0.6;
    const ctaCategory = (isGenericAsk || mixedStyles) ? "footwear" : dominantCat;
    const dominantColor = dominantRequestedColor(ctx);
    const ctaScope = {
      ...(dominantGender ? { gender: dominantGender } : {}),
      ...(ctaCategory ? { category: ctaCategory } : {}),
      ...(dominantColor ? { color: dominantColor } : {}),
    };
    const ctaScopePossible = catalogScopeHasMatches(ctx.catalogFacetIndex, ctaScope);
    if (ctaScopePossible === false) {
      return {
        link: null,
        kind: "catalog-no-match",
        diagnostics: {
          gender: dominantGender || "",
          category: ctaCategory || "",
          color: dominantColor || "",
          patternSet: !!ctx.storefrontSearchUrlPattern,
          overrideCount: (ctx.ctaOverrides || []).length,
        },
      };
    }

    const auto = buildStorefrontSearchCTA({
      pattern: ctx.storefrontSearchUrlPattern,
      overrides: ctx.ctaOverrides,
      gender: dominantGender,
      category: ctaCategory,
      color: dominantColor,
      latestUserMessage: ctx.latestUserMessage || "",
    });

    return {
      link: auto ? { url: auto.url, label: auto.label } : null,
      kind: auto ? "auto" : "auto-miss",
      diagnostics: {
        gender: dominantGender || "",
        category: ctaCategory || "",
        color: dominantColor || "",
        patternSet: !!ctx.storefrontSearchUrlPattern,
        overrideCount: (ctx.ctaOverrides || []).length,
      },
    };
  }

  if (
    Array.isArray(ctx.collectionLinks) &&
    ctx.collectionLinks.length > 0 &&
    hasCategories &&
    !ctx.categoryIntentAmbiguous
  ) {
    const normalizedGender = String(dominantGender || "").toLowerCase().trim();
    const catMatches = (linkCat, cat) => {
      if (!linkCat) return false;
      return linkCat === cat || cat.includes(linkCat) || linkCat.includes(cat);
    };
    const exact = ctx.collectionLinks.find((link) => {
      const linkCat = String(link?.category || "").toLowerCase().trim();
      const linkGender = String(link?.gender || "").toLowerCase().trim();
      if (!linkCat || !link?.url || !linkGender) return false;
      return catMatches(linkCat, dominantCat) && linkGender === normalizedGender;
    });
    const fallback = !exact && ctx.collectionLinks.find((link) => {
      const linkCat = String(link?.category || "").toLowerCase().trim();
      const linkGender = String(link?.gender || "").toLowerCase().trim();
      if (!linkCat || !link?.url || linkGender) return false;
      return catMatches(linkCat, dominantCat);
    });
    const match = exact || fallback;
    if (match) {
      return {
        link: {
          url: match.url,
          label: `Shop all ${String(match.label || match.category).trim()}`,
        },
        kind: "legacy-collection",
        diagnostics: {
          gender: dominantGender || "",
          category: dominantCat || "",
          color: "",
          patternSet: false,
          overrideCount: 0,
        },
      };
    }
  }

  return { link: null, kind: "none", diagnostics: {} };
}

export function validateTurnResult(result = {}) {
  const warnings = [];
  const text = String(result.text || "");
  const products = Array.isArray(result.products) ? result.products : [];
  const chips = Array.isArray(result.chips) ? result.chips : [];

  if (text.length < 3) {
    warnings.push({
      code: "empty_text",
      message: "TurnResult text is empty or too short.",
    });
  }

  if (products.length > 0 && chips.length > 0) {
    const beforeFirstChip = text.slice(0, text.indexOf("<<")).trim();
    if (/\b(?:what|which)\s+(?:type|kind|style|category)\b|\b(?:men'?s?|women'?s?|male|female)\s+or\s+(?:men'?s?|women'?s?|male|female)\b/i.test(beforeFirstChip)) {
      warnings.push({
        code: "cards_with_gating_chips",
        message: "Product cards are present while text still asks a gating chip question.",
      });
    }
  }

  if (products.length === 0 && /\b(?:here are|take a look|check out|these are|i found|closest matches)\b/i.test(text)) {
    warnings.push({
      code: "pitch_without_products",
      message: "Text presents product options but no product cards are attached.",
    });
  }

  if (products.length > 0 && detectAiNoMatchPhrasing(text)) {
    warnings.push({
      code: "denial_with_products",
      message: "Text contains no-match wording while product cards are attached.",
    });
  }

  return warnings;
}
