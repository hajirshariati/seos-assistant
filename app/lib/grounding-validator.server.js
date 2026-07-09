// Grounding validator. The architectural piece neither previous
// attempt had — checks that every load-bearing claim in the model's
// reply is supported by a tool result from THIS turn. On failure,
// returns a structured error the agent loop can hand BACK to the
// model with a retry instruction ("you said X; no evidence supports
// X; rewrite"). Never silently rewrites text — that's how the old
// pipeline produced answers no one wrote.
//
// What counts as "load-bearing":
//   - Named products (bolded **Product Name**)
//   - Specific prices ($X.XX)
//   - Feature claims tied to specific products
//     ("X has BioRocker", "Y has memory foam", "Z is waterproof")
//
// What we don't check (the model's natural language style is fine):
//   - General prose, voice, greetings
//   - Generic descriptions ("comfortable", "stylish")
//   - Customer-facing closings
//
// Returns:
//   { ok: true }                                   — text is grounded
//   { ok: false, errors: [{kind, claim, ...}] }    — feed back to model

import {
  detectProcessNarration,
  shouldBlockProcessNarration,
  PROCESS_NARRATION_RETRY_INSTRUCTION,
  detectUnsupportedMedicalClaim,
  MEDICAL_CLAIM_RETRY_INSTRUCTION,
  detectWeakNonAnswer,
  WEAK_NON_ANSWER_RETRY_INSTRUCTION,
  ADVISORY_QUALITY_WORKFLOWS,
} from "./sales-voice.js";
import {
  containsUnsupportedCompatibilityClaim,
  hasExplicitOrthoticCompatibleEvidence,
  buildOrthoticCompatibilityAnswer,
} from "./compatibility-truth.server.js";

// Token-level family extractor (same as the old guard so behavior
// matches the working parts of today's pipeline).
const FAMILY_STOP_WORDS = new Set([
  "the", "a", "an", "my", "our", "new", "your",
  "men", "men's", "women", "women's", "kids", "unisex",
]);
function titleFamily(title) {
  if (!title) return "";
  const beforeDash = String(title).split(/\s[-–—]\s/)[0];
  const words = beforeDash
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const w of words) {
    if (w.length > 2 && !FAMILY_STOP_WORDS.has(w)) return w;
  }
  return "";
}

// Bolded product mentions in the reply. Mirrors detectNamedProductMismatch
// in response-contract.server.js but is non-mutating — we only collect
// claims, never rewrite. Trademark/technology-name bolds are filtered
// the same way as the existing mismatch guard so we don't double-count
// "**BioRocker™ Technology**" as a product family.
function extractBoldedProductFamilies(text) {
  if (!text || typeof text !== "string") return [];
  const matches = text.match(/\*\*([^*]{3,80})\*\*/g) || [];
  const out = [];
  for (const m of matches) {
    const inner = m.replace(/^\*\*|\*\*$/g, "").trim();
    if (inner.length < 5 || !/[A-Z]/.test(inner)) continue;
    // Generic emphasis bolds, headings, or tech/feature labels.
    if (/^(?:yes|no|note|important|warning|tip|here|now|today|great)\b/i.test(inner)) continue;
    if (/[™®©]/.test(inner)) continue;
    // Tech/feature/section vocabulary — plural-tolerant ((?:s)?\b).
    // Live trace 2026-06-10 evening: "**Style & Materials**" burned
    // TWO retries (~25s) because "Materials" didn't match \bMaterial\b
    // (no word boundary before the plural 's') and "Style" wasn't in
    // the list at all. Section headings the model naturally writes in
    // spec answers — Style, Comfort, Fit, Sizing, Details, Specs,
    // Design, Construction, Overview, Summary, Verdict — are now
    // recognized.
    if (/\b(?:Technolog(?:y|ies)|System|Method|Approach|Feature|Series|Collection|Platform|Footbed|Midsole|Outsole|Insole|Foam|Material|Lining|Upper|Mission|HQ|Headquarters|Bottom\s+line|Style|Comfort|Fit|Sizing|Detail|Spec(?:ification)?|Design|Construction|Overview|Summar(?:y|ies)|Verdict|Pro|Con|Difference|Highlight|Takeaway|Heel\s+Height|Removable\s+Insole|Closure|Best\s+for|Vibe|Category|Price\s+Range|Weight|Cushioning)s?\b/i.test(inner)) continue;
    // Ampersand bolds are section headings ("Style & Materials",
    // "Fit & Sizing") — no product title in this catalog contains "&".
    if (inner.includes("&")) continue;
    // Brand-prefixed tech phrases ("Aetrex Signature Arch Support",
    // "Aetrex Orthotic System") are brand/technology references —
    // product titles never start with the brand name. Live trace
    // 2026-06-10: "**Aetrex Signature Arch Support**" was flagged as
    // an ungrounded product and burned a retry on a grounded answer.
    if (/^Aetrex\b/i.test(inner)) continue;
    // Feature/spec phrases the model bolds as compare/section headers
    // ("Built-in Arch Support", "Memory Foam", "Heel Cup", "Removable
    // Insole") are FEATURES, not product names. Prod trace 2026-06-24:
    // "**Built-in Arch Support**" was extracted as a product (family
    // "built") and burned 3 Sonnet retries on an otherwise-grounded
    // comparison. Match the phrase as a whole so real product titles that
    // merely contain these words (e.g. "Danika Arch Support Sneaker") still
    // extract — those have a leading name token before the feature.
    if (/^(?:built[\s-]?in\s+|with\s+|genuine\s+|true\s+)?(?:arch\s+support|memory\s+foam|heel\s+cup|metatarsal(?:\s+support|\s+pad)?|cork\s+(?:footbed|midsole)|biorocker|ultra[\s-]?sky|lynco|removable\s+insoles?|rocker[\s-]?bottom|orthotic\s+support)\b\s*$/i.test(inner)) continue;
    // Heading-style bolds end in punctuation (colon, em/en dash) —
    // "**The key difference:**", "**Quick take —**", "**Bottom line:**".
    // These are sentence headings, not product names. Live trace
    // 2026-06-10: BioRocker compare retry burned 10s because the
    // validator extracted "key" from "**The key difference:**".
    if (/[:!?—–]$/.test(inner)) continue;
    // Product names don't end with verbs/closers like "is" or "and".
    if (/\b(?:is|are|was|were|and|or|but|the|a|an)$/i.test(inner)) continue;
    // Size ranges / measurements the model bolds in fit & sizing answers
    // ("**7 US through 15 US**", "**sizes 6–11**", "**9.5 wide**") are
    // facts from variant data, NOT product names. Prod trace 2026-06-24:
    // "**7 US through 15 US**" burned 3 attempts (Haiku + 2 Sonnet) on a
    // correctly-grounded orthotic sizing answer.
    if (/\b(?:US|UK|EU|EUR)\b/.test(inner) && /\d/.test(inner)) continue;
    if (/^\s*(?:sizes?\s+)?\d+(?:\.\d+)?\s*(?:[-–—]|to|through|thru)\s*\d/i.test(inner)) continue;
    if (/\b\d+(?:\.\d+)?\s*(?:cm|mm|in(?:ch(?:es)?)?|narrow|wide|medium)\b/i.test(inner)) continue;
    // Quoted phrases the model bolds (definitions, translations, or a
    // customer quote — '**"one who has completed the Hajj"**') are not
    // product names. Prod trace 2026-06-24: a Farsi definition answer
    // burned a Sonnet retry because the bolded gloss was read as a product.
    if (/^["'“”‘’]/.test(inner) && /["'“”‘’]$/.test(inner)) continue;
    const family = titleFamily(inner);
    if (family) out.push({ phrase: inner, family });
  }
  return out;
}

// Extract dollar-figure claims with the product they're attached to.
// "Noelle is $90.97" or "Noelle Arch Support Wedge - Black - $90.97".
function extractPriceClaims(text) {
  if (!text || typeof text !== "string") return [];
  const out = [];
  // Bolded product followed by price within ~80 chars, common shapes
  // the synthesizer emits.
  const re = /\*\*([^*]{3,80})\*\*[^.\n]{0,80}?\$([0-9]{1,4}(?:\.[0-9]{2})?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const family = titleFamily(m[1]);
    if (family) {
      out.push({ phrase: m[1].trim(), family, price: parseFloat(m[2]) });
    }
  }
  return out;
}

// Feature/material claim tied to a specific product. Patterns:
//   "Noelle has BioRocker"
//   "the Reagan has memory foam"
//   "Maui features waterproof"
const FEATURE_KEYWORDS = [
  "biorocker", "ultrasky", "ultra sky", "ultra-sky",
  "lynco", "aetrex orthotic",
  "memory foam", "cork", "leather", "mesh", "suede",
  "waterproof", "vegan", "merino", "wool",
  "arch support", "metatarsal", "heel cup",
];
function extractFeatureClaims(text) {
  if (!text || typeof text !== "string") return [];
  const out = [];
  const boldFamilies = extractBoldedProductFamilies(text);
  if (boldFamilies.length === 0) return out;
  const lower = text.toLowerCase();
  for (const { phrase, family } of boldFamilies) {
    // Find this product's name in lower text, then look at the next
    // ~140 chars (typical clause + sentence end) for feature words.
    const idx = lower.indexOf(phrase.toLowerCase());
    if (idx < 0) continue;
    const window = lower.slice(idx, idx + phrase.length + 140);
    for (const feature of FEATURE_KEYWORDS) {
      if (window.includes(feature)) {
        out.push({ family, productPhrase: phrase, feature });
      }
    }
  }
  return out;
}

// Check whether a card supports a feature claim. Looks at description,
// tags, attributes, and any claim-facts the engine attached. The
// existing product-claim-facts pipeline already builds verified facts —
// we just consult the same evidence.
function cardSupportsFeature(card, feature) {
  if (!card) return false;
  // Scan everything the search/lookup tools attach to a card. Live trace
  // 2026-06-10: "the Jillian has memory foam" was rejected because
  // `_description` was empty on the card (the product's spec lives in
  // a metafield/variant-attribute JSON, not in shopify's description
  // field). The model had seen the value through variantFacts and
  // attributes; the validator was looking at fewer fields than the
  // model did. Now we scan the same surfaces the tool result exposes.
  const variantFactsStr =
    typeof card._variantFacts === "object" && card._variantFacts
      ? JSON.stringify(card._variantFacts)
      : "";
  const variantsStr =
    Array.isArray(card._variants)
      ? card._variants.map((v) => JSON.stringify(v?.attributesJson || {})).join(" ")
      : "";
  const haystack = [
    card._description,
    card._descriptionSnippet,
    Array.isArray(card._tags) ? card._tags.join(" ") : "",
    typeof card._attributes === "object" ? JSON.stringify(card._attributes) : "",
    card.title,
    card._productType,
    variantFactsStr,
    variantsStr,
  ].join(" ").toLowerCase();
  if (haystack.includes(feature)) return true;
  // Also match common spelling variants without requiring per-feature
  // patching ("memory foam" ↔ "memory-foam", "memoryfoam").
  const collapsed = haystack.replace(/[-\s]+/g, "");
  const featureCollapsed = feature.replace(/[-\s]+/g, "");
  if (featureCollapsed && collapsed.includes(featureCollapsed)) return true;
  // Claim facts (provenance-tagged) — preferred evidence.
  const claimFacts = card._claimFacts || {};
  // Map feature words to fact keys the claim builder maintains.
  const featureKey = {
    "arch support": "archSupport",
    "memory foam": "memoryFoam",
    "cork": "cork",
    "leather": "leather",
    "waterproof": "waterproof",
    "vegan": "vegan",
    "mesh": "mesh",
    "suede": "suede",
    "metatarsal": "metatarsalSupport",
    "heel cup": "heelCup",
  }[feature];
  if (featureKey && claimFacts[featureKey]?.value === true) return true;
  return false;
}

// Main entry point. Inputs:
//   text   — the model's reply text
//   pool   — the product cards the model had access to this turn
//            (from search_products / lookup_sku / find_similar tool results)
// Returns:
//   { ok, errors }
//
// Errors describe what to tell the model on retry. Each error is
// self-explanatory enough that the model can fix it without seeing
// the validator's source.
// Rule-4 helper. Detect a FALSE catalog denial: the model claims we don't
// carry a GENDER+CATEGORY that the catalog actually has (prod trace
// 2026-06-24: "I couldn't find men's footwear" when men's footwear exists).
// Conservative on purpose — only GENDERED denials ("men's <cat>") are
// flagged, never bare-category denials, so honest color/size relaxation
// ("no red sandals") is never touched. "footwear"/"shoes" is an umbrella
// over any real footwear category. categoryGenderMap: { [cat]: { genders } }.
function detectFalseCatalogDenial(text, categoryGenderMap) {
  if (!text || !categoryGenderMap || typeof categoryGenderMap !== "object") return null;
  const lower = String(text).toLowerCase();
  const DENY =
    "(?:don'?t|do not|doesn'?t|does not)\\s+(?:currently\\s+)?(?:carry|have|stock|sell|offer)|" +
    "couldn'?t\\s+find|could\\s*not\\s+find|can'?t\\s+find|cannot\\s+find|no\\s+longer\\s+(?:carry|offer|stock)";
  const GENDER_TOKENS = { men: ["men's", "mens", "men"], women: ["women's", "womens", "women"] };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entries = Object.entries(categoryGenderMap).filter(
    ([k, v]) => k && k.length >= 3 && v && Array.isArray(v.genders) && v.genders.length > 0,
  );
  // Footwear umbrella: a real footwear category (not orthotics/accessories).
  const NON_FOOTWEAR = new Set(["orthotics", "orthotic", "insoles", "insole", "accessories", "accessory"]);
  const genderHasAnyFootwear = (g) =>
    entries.some(([k, v]) =>
      !NON_FOOTWEAR.has(String(k).toLowerCase()) &&
      v.genders.map((x) => String(x).toLowerCase()).some((x) => x === g || x === "unisex"),
    );

  for (const g of ["men", "women"]) {
    const toks = GENDER_TOKENS[g].map(esc).join("|");
    // Umbrella ("men's footwear" / "men's shoes") — flag if ANY footwear exists.
    const umbrellaRe = new RegExp(`\\b(?:${DENY})\\b[^.?!\\n]{0,25}?\\b(?:${toks})\\s+(?:footwear|shoes?)\\b`, "i");
    if (umbrellaRe.test(lower) && genderHasAnyFootwear(g)) {
      return { gender: g, category: "footwear" };
    }
    // Specific category ("men's <cat>") — flag if that gender genuinely has it.
    for (const [catKey, entry] of entries) {
      const supported = new Set(entry.genders.map((x) => String(x).toLowerCase()));
      if (!supported.has(g) && !supported.has("unisex")) continue;
      const c = String(catKey).toLowerCase().trim();
      const stem = c.endsWith("s") ? c.slice(0, -1) : c;
      const catAlt = [...new Set([c, stem])].map((v) => `${esc(v)}s?`).join("|");
      const re = new RegExp(`\\b(?:${DENY})\\b[^.?!\\n]{0,25}?\\b(?:${toks})\\s+(?:${catAlt})\\b`, "i");
      if (re.test(lower)) return { gender: g, category: catKey };
    }
  }
  return null;
}

// Rule-5 helpers. A FALSE color denial: the model tells the customer a
// product doesn't come in a color it actually offers ("the Jillian doesn't
// come in black" when black is a stocked variant). Customer-harm identical
// to rule 4 (lost sale + wrong answer), one level down at the variant.
//
// Conservative by construction — fires ONLY when BOTH hold:
//   (a) the model used a recognized color word inside a denial construction, and
//   (b) the matched card's own variant/colour/title evidence contains that
//       exact color (word-boundary match, so "tan" never matches "Titanium").
// An HONEST denial ("no red Jillian" when there truly is no red) finds no
// matching evidence and is never flagged. We only ever test a SPECIFIC color
// the model named, so no global color taxonomy / normalization is needed —
// keeping this module import-free (the eval harness runs without Prisma).
const COLOR_WORDS = [
  "black", "white", "navy", "blue", "red", "green", "tan", "brown", "grey", "gray",
  "pink", "purple", "beige", "ivory", "cream", "gold", "silver", "bronze", "burgundy",
  "charcoal", "khaki", "olive", "coral", "teal", "maroon", "mauve", "taupe", "camel",
  "cognac", "oat", "oatmeal", "blush", "nude", "wine", "rust", "mustard", "lavender",
  "mint", "peach", "yellow", "orange", "plum", "stone", "sand", "chestnut", "mocha",
];
const COLOR_ALT = COLOR_WORDS.join("|");
// "...doesn't come in black", "isn't available in red", "no longer made in tan".
const COLOR_DENY_IN_RE = new RegExp(
  "(?:don'?t|do not|doesn'?t|does not|isn'?t|is not|aren'?t|are not|wasn'?t|" +
  "no\\s+longer|not)\\s+(?:currently\\s+)?(?:come|comes|coming|have|has|offer|" +
  "offered|stock|stocked|carry|carried|available|made|make|sold)\\b" +
  "[^.?!\\n]{0,40}?\\bin\\s+(" + COLOR_ALT + ")\\b",
  "ig",
);
// "no black option", "no red colorway", "no white version".
const COLOR_DENY_NO_RE = new RegExp(
  "\\bno\\s+(" + COLOR_ALT + ")\\s+(?:option|version|colou?rway|colou?r|variant)\\b",
  "ig",
);

// Equivalence so "grey" denial matches "Gray" evidence (and vice versa).
function colorEquivalents(color) {
  const c = String(color).toLowerCase();
  if (c === "grey") return ["grey", "gray"];
  if (c === "gray") return ["gray", "grey"];
  return [c];
}

// The color strings a card actually offers, from the same surfaces the
// search/lookup tools attach (variant facts authoritative, then attributes,
// then title suffix + tags). Lower-cased haystack; callers word-boundary test.
function cardColorHaystack(card) {
  if (!card || typeof card !== "object") return "";
  const parts = [];
  const vf = card._variantFacts && typeof card._variantFacts === "object" ? card._variantFacts : {};
  for (const k of ["availableColors", "colors", "productAvailableColors"]) {
    if (Array.isArray(vf[k])) parts.push(vf[k].join(" "));
  }
  if (Array.isArray(vf.byColor)) parts.push(vf.byColor.map((b) => (b && b.color) || "").join(" "));
  const attr = card._attributes && typeof card._attributes === "object" ? card._attributes : {};
  for (const k of ["color", "colour", "Color", "Colour", "Color Family", "colorFamily"]) {
    const v = attr[k];
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) parts.push(v.join(" "));
  }
  parts.push(String(card.title || ""));
  if (Array.isArray(card._tags)) parts.push(card._tags.join(" "));
  return parts.join(" ").toLowerCase();
}

function cardOffersColor(card, color) {
  const hay = cardColorHaystack(card);
  if (!hay) return false;
  return colorEquivalents(color).some((c) => {
    try {
      return new RegExp(`\\b${c}\\b`, "i").test(hay);
    } catch {
      return false;
    }
  });
}

// Find false color denials. For each denial match, resolve WHICH product it's
// about: the nearest bolded product family appearing before the match (the
// product under discussion), else — when the pool holds exactly one card —
// that card. Returns [{ productPhrase, color, card }].
function detectFalseColorDenials(text, pool, poolByFamily) {
  if (!text || typeof text !== "string") return [];
  const cards = Array.isArray(pool) ? pool : [];
  if (cards.length === 0) return [];
  const bolds = extractBoldedProductFamilies(text);
  const lower = text.toLowerCase();
  // Pre-index bold family positions for "nearest bold before the denial".
  const boldPositions = bolds
    .map((b) => ({ ...b, idx: lower.indexOf(b.phrase.toLowerCase()) }))
    .filter((b) => b.idx >= 0 && poolByFamily.has(b.family))
    .sort((a, b) => a.idx - b.idx);

  const resolveCard = (matchIdx) => {
    let chosen = null;
    for (const b of boldPositions) {
      if (b.idx <= matchIdx) chosen = b;
      else break;
    }
    if (chosen) return { card: poolByFamily.get(chosen.family), phrase: chosen.phrase };
    if (cards.length === 1) return { card: cards[0], phrase: String(cards[0]?.title || "this product") };
    return null;
  };

  const out = [];
  const seen = new Set();
  for (const re of [COLOR_DENY_IN_RE, COLOR_DENY_NO_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const color = String(m[1] || "").toLowerCase();
      if (!color) continue;
      const resolved = resolveCard(m.index);
      if (!resolved || !resolved.card) continue;
      if (!cardOffersColor(resolved.card, color)) continue; // honest denial — leave it
      const key = `${titleFamily(resolved.phrase)}|${color}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ productPhrase: resolved.phrase, color, card: resolved.card });
    }
  }
  return out;
}

// Raw product handle / slug detector. Cleanup can strip a malformed draft
// down to a bare handle ("jillian-cork-sc364w") — an internal hyphenated
// slug the customer must never see (live trace 2026-06-25 shipped
// "Jillian-cork-sc364w jillian-cork-sc364w" as the entire reply). We flag
// a hyphenated token when it either (a) exactly matches a handle in this
// turn's pool, or (b) has 3+ hyphen parts ending in a SKU-like segment
// (letters+digits, e.g. "sc364w", "8000w"). Ordinary hyphenated words
// ("slip-on", "anti-fatigue", "lace-up") have no SKU tail and aren't pool
// handles, so they never trip.
const HANDLE_SKU_TAIL_RE = /^[a-z]{0,4}\d{2,5}[a-z]{0,2}$/;
function detectRawHandleLeaks(text, pool) {
  const out = [];
  const seen = new Set();
  const handles = new Set();
  for (const c of Array.isArray(pool) ? pool : []) {
    const h = String(c?.handle || "").toLowerCase().trim();
    if (h) handles.add(h);
  }
  const slugRe = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g;
  let m;
  while ((m = slugRe.exec(text)) !== null) {
    const slug = m[0];
    const lc = slug.toLowerCase();
    if (seen.has(lc)) continue;
    const segs = lc.split("-");
    const last = segs[segs.length - 1];
    const looksLikeSku = segs.length >= 3 && HANDLE_SKU_TAIL_RE.test(last) && /\d/.test(last);
    if (handles.has(lc) || looksLikeSku) {
      seen.add(lc);
      out.push(slug);
    }
  }
  return out;
}

// ─── Retail answer-contract helpers (rules 7 & 8) ──────────────────
//
// These enforce SHAPE, not truth: a product/advisory answer should be
// concise and lead with a direct answer, not an essay or generic browse
// copy. Gated on a non-empty userMessage (so truth-only callers / evals
// are unaffected) and killable in prod via VALIDATOR_STYLE_RULES=off.

const MAX_RETAIL_WORDS = Number(process.env.VALIDATOR_MAX_WORDS) || 160;
// Visual cap: 160 words still overflows the narrow widget. ~500 chars is
// the comfortable ceiling for a normal answer. Env-overridable.
const MAX_RETAIL_CHARS = Number(process.env.VALIDATOR_MAX_CHARS) || 500;
// A substantive answer to a decision question should be at least this many
// words (answer + tradeoff + next step). Below it reads as a fragment.
const MIN_DECISION_WORDS = Number(process.env.VALIDATOR_MIN_DECISION_WORDS) || 25;
// Any reply this short on a turn with a real question or cards is a
// fragment ("Great question —", "Absolutely —", "I'd say —").
const FRAGMENT_MIN_WORDS = 5;

// A sizing / availability question — must be answered in TEXT, not just
// with a card carousel.
const SIZING_AVAILABILITY_RE = new RegExp(
  "\\bwhat\\s+size\\b" + "|" +
  "\\bwhich\\s+size\\b" + "|" +
  "\\bsize\\s+(?:should|do|would|to\\s+(?:get|order|buy))\\b" + "|" +
  "\\b(?:run|runs)\\s+(?:small|large|big|narrow|wide|tight)\\b" + "|" +
  "\\btrue\\s+to\\s+size\\b" + "|" +
  "\\bsize\\s+up\\b|\\bsize\\s+down\\b" + "|" +
  "\\bsize\\s*\\d+(?:\\.5)?\\b" + "|" +
  "\\b(?:in\\s+stock|out\\s+of\\s+stock|sold\\s+out|back\\s+in\\s+stock)\\b",
  "i",
);
// Heuristic that the reply actually ENGAGES sizing/availability (so we
// don't false-reject a real answer). Mentions a size/fit concept, an
// availability verdict, or a safe-guidance hook.
const SIZING_ANSWERED_RE = new RegExp(
  "\\b(?:size|sizing|fit|fits|true\\s+to\\s+size|half[-\\s]?size|usual|swell|adjustable|strap|snug|roomy|go\\s+up|go\\s+down|size\\s+up|size\\s+down|in\\s+stock|out\\s+of\\s+stock|sold\\s+out|available|unavailable|return|returns|exchange|width|wide|narrow)\\b" + "|" +
  "\\b\\d+(?:\\.5)?\\b",
  "i",
);
// A reply that ends mid-thought on a connector/dash — the classic gutted
// fragment ("Great question —", "I'd say —").
const DANGLING_FRAGMENT_RE = /[—–-]\s*$|\b(?:so|but|and|or|because|with|for|to|the)\s*$/i;

// A decision / suitability question — the kind that MUST be answered in
// the first sentence ("is it worth it?", "will it hold up?", "good for
// plantar fasciitis?", "casual or active?", "which should I buy?").
const DECISION_QUESTION_RE = new RegExp(
  "\\bis\\s+it\\s+(?:actually\\s+)?worth\\b" + "|" +
  "\\bworth\\s+(?:it|the|that|buying|paying|the\\s+(?:money|price|extra))\\b" + "|" +
  "\\bwill\\s+(?:it|this|these|they)\\s+(?:hold\\s+up|last|work|be|survive)\\b" + "|" +
  "\\bhold\\s+up\\b" + "|" +
  "\\bgood\\s+(?:for|enough)\\b" + "|" +
  "\\b(?:good|ok|okay|suitable|durable|comfortable|right|enough)\\s+(?:for|to)\\b" + "|" +
  "\\bmore\\s+of\\s+a\\b" + "|" +
  "\\bwhich\\s+(?:one\\s+)?(?:should|do|would|is)\\b" + "|" +
  "\\bshould\\s+i\\s+(?:buy|order|get|choose|pick|go)\\b" + "|" +
  "\\b(?:is|are)\\s+(?:this|it|that|these|they)\\b[^.?!\\n]{0,40}\\b(?:casual|active|sporty|dressy|formal|worth|suitable)\\b",
  "i",
);

// The user explicitly wants depth — exempt from the length cap. Mirrors
// emit-finalize's REVIEW_FIT_RETURN_OR_COMPARE_RE so the two layers agree.
const DETAIL_REQUEST_RE = new RegExp(
  "\\b(?:compare|comparison|vs\\.?|versus|difference\\s+between|review|reviews|rated|rating|what\\s+(?:do\\s+)?(?:people|customers|others)\\s+(?:say|think)|return|refund|exchange|policy|warranty|spec|specs|material|technolog|feature|ingredient|how\\s+(?:does|do)\\s+(?:it|they)\\s+work|how\\s+it\\s+works|what\\s+makes|explain|in\\s+detail|details|detailed|breakdown|walk\\s+me\\s+through|everything\\s+about|tell\\s+me\\s+(?:more|everything)|full\\b)\\b",
  "i",
);

// Generic listing/browse leads that must NOT open a decision answer.
const GENERIC_LEAD_RE =
  /^(?:here\s+(?:are|is|'?s)\b|these\s+are\b|take\s+a\s+look\b|i\s+found\b|i'?ve\s+(?:got|found)\b|let\s+me\s+(?:show|pull|grab)\b|check\s+(?:out|these)\b|browse\b|i\s+have\s+(?:a\s+few|some)\b|we\s+(?:have|carry)\b)/i;

// Intents that REQUIRE real product data to answer honestly — value,
// suitability, condition-fit, sizing, availability. A named-product
// question of this shape must be grounded in fetched product/variant data,
// not general knowledge, and a generic "browse these" fallback is a
// non-answer for it. (Pure educational/clinical questions — "is arch
// support necessary for plantar fasciitis?" — are gated out separately by
// requiring that the customer actually NAMED a product.)
const PRODUCT_DATA_INTENT_RE = new RegExp(
  "\\b(?:worth\\b|hold\\s+up|holds\\s+up|durable|last\\b|lasts\\b)" + "|" +
  "\\bgood\\s+(?:for|enough)\\b" + "|" +
  "\\b(?:suitable|comfortable|right|enough)\\s+(?:for|to)\\b" + "|" +
  "\\bmore\\s+of\\s+a\\b" + "|" +
  "\\bwhich\\s+(?:one\\s+)?(?:should|do|would|is)\\b" + "|" +
  "\\bshould\\s+i\\s+(?:buy|order|get|choose|pick|go)\\b" + "|" +
  "\\b(?:plantar|fasciitis|bunion|neuroma|metatarsal|overpronat|supinat|sesamoid|capsulitis|fallen\\s+arch|flat\\s+feet|heel\\s+(?:pain|spur)|arch\\s+(?:pain|support))\\b" + "|" +
  "\\b(?:size|sizing|fit|fits|true\\s+to\\s+size|wide|narrow|in\\s+stock|come[s]?\\s+in|available|availabilit)\\b" + "|" +
  "\\b(?:walking|standing|all[-\\s]?day|active)\\b",
  "i",
);

// A two-product comparison turn. On these the model makes per-product
// DISTINCTIONS ("the Savannah is sturdier for walking") that the feature
// checker misreads as unsupported universal claims, causing pointless retry
// loops (live trace 2026-06-25: "Jillian or Savannah?" looped 3× on
// "Savannah wins for walking"). The response-contract verifier already skips
// compare turns for the same reason; we mirror that here.
const COMPARISON_RE =
  /\b(?:vs\.?|versus|compare[ds]?|comparison|which\s+is\s+better|better\s+(?:for|than)|which\s+(?:one\s+)?should\s+i)\b/i;

// Generic "browse these" fallbacks that emit-finalize ships when a real
// answer was wiped — a non-answer for any specific question.
const GENERIC_FALLBACK_RE =
  /^(?:take\s+a\s+look\b|here\s+are\s+the\s+(?:matching|closest)|these\s+are\s+the\s+closest|i'?m\s+not\s+finding\s+a\s+clean\s+match|tell\s+me\s+a\s+bit\s+more\b)/i;

// BLOCKING vs WARNING. True safety/factual problems always force a retry and
// block shipping. Answer-quality rules remain warnings on open-ended browse
// turns, but block on answer workflows where a specific customer question is
// owed a specific answer.
const BLOCKING_KINDS = new Set([
  "ungrounded_product_name",
  "wrong_price",
  "unsupported_feature_claim",
  "false_catalog_denial",
  "false_color_denial",
  "raw_handle_leak",
  // Compatibility product-truth: an unsupported orthotic↔sandal claim
  // ("removable footbed", "orthotics drop into sandals") with no explicit
  // catalog evidence is a safety/factual failure — block and force a rewrite to
  // the Aetrex-safe answer (closed shoes / built-in-support sandals).
  "unsupported_compatibility_claim",
  // Answer workflows (availability/comparison/named-product/condition) owe a
  // real answer — a generic "take a look" or stock clarifier is a non-answer
  // and forces a synthesis retry. Scoped to those workflows via the
  // `workflow` arg, so plain browse turns are unaffected.
  "answer_workflow_non_answer",
  // Advisory quality (scoped to ADVISORY_QUALITY_WORKFLOWS): an unsupported
  // medical cure/treat claim is a factual overreach; a "tell me more" stall when
  // the customer already gave use case + category/condition is a non-answer.
  "unsupported_medical_claim",
  "advisory_weak_non_answer",
]);

// Workflows that must answer (kept in sync with turn-plan ANSWER_WORKFLOWS).
const ANSWER_WORKFLOW_NAMES = new Set([
  "availability",
  "prior_evidence_availability",
  "comparison",
  "named_product_advisory",
  "condition_recommendation",
  "multi_recommendation",
  "compatibility",
  "sizing_help",
]);

// Quality kinds that are observability-only on browse turns but BLOCKING on
// answer workflows (the customer is owed a real, substantive answer).
export const ANSWER_WORKFLOW_BLOCKING_KINDS = new Set([
  "answer_workflow_non_answer",
  "fragment_non_answer",
  "sizing_not_addressed",
  "generic_fallback_non_answer",
]);

// Stock clarifier stalls — a non-answer when the plan said act-don't-ask.
// Covers gender stalls, "for you or a partner / someone else", "who are these
// for", "is this for you", and "tell me more / what style/color/budget".
const PLAN_CLARIFIER_RE = new RegExp(
  [
    "\\bmen'?s?\\s+or\\s+women'?s?\\b",
    "\\bwomen'?s?\\s+or\\s+men'?s?\\b",
    "\\bare\\s+(?:you|these|they|this)\\s+(?:shopping\\s+)?for\\b", // are you/these for ...
    "\\bshopping\\s+for\\s+(?:yourself|someone|a\\s+man|a\\s+woman|him|her|them)\\b",
    "\\bfor\\s+(?:you|yourself)\\s+or\\s+(?:a\\s+)?(?:partner|someone|somebody|husband|wife|friend|spouse|else)\\b",
    "\\b(?:who|whom)\\s+(?:are|is)\\s+(?:these|they|this|it)\\s+for\\b",
    "\\bis\\s+(?:this|it|that)\\s+for\\s+(?:you|yourself)\\b",
    "\\bwhat\\s+(?:style|color|colou?r|budget|kind|type|size|occasion)\\b[^.?!]*\\?",
    "\\btell\\s+me\\s+(?:a\\s+(?:little|bit)\\s+)?more\\b",
    "\\bcould\\s+you\\s+(?:tell|give|share)\\s+me\\s+(?:a\\s+(?:little|bit)\\s+)?more\\b",
  ].join("|"),
  "i",
);

function retailWordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function firstSentenceOf(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  const m = t.match(/^[^.!?\n]*[.!?]?/);
  return (m ? m[0] : t).trim();
}

export function validateGrounding({ text, pool = [], categoryGenderMap = null, userMessage = "", namedProductMentioned = false, searchAttempted = false, workflow = "" } = {}) {
  const errors = [];
  if (!text || typeof text !== "string") return { ok: true, errors, warnings: [] };

  const poolByFamily = new Map();
  for (const card of pool || []) {
    const family = titleFamily(card?.title || "");
    if (family && !poolByFamily.has(family)) poolByFamily.set(family, card);
  }

  // 1. Named-product grounding.
  // Every bolded product family must correspond to a card in the pool.
  // (Tech/feature bolds were already filtered by extractBoldedProductFamilies.)
  //
  // ONLY when there IS a product pool this turn. On an info/policy/efficacy
  // turn no search ran (pool empty) and a bolded product is an honest
  // reference, not a "here's what I'm showing you" claim — flagging it just
  // burns retries (prod 2026-06-25: "**Plantar Fasciitis Kit**" on a "do
  // insoles help?" answer, "**Miles**…" wrongly forced a Sonnet retry). With
  // an empty pool there's also nothing to ground against, so the rule can
  // only false-positive. Rules 2/3 already skip on no-card; this matches.
  if (poolByFamily.size > 0) {
    const boldFamilies = extractBoldedProductFamilies(text);
    const seenFamilies = new Set();
    for (const { phrase, family } of boldFamilies) {
      if (seenFamilies.has(family)) continue;
      seenFamilies.add(family);
      if (!poolByFamily.has(family)) {
        errors.push({
          kind: "ungrounded_product_name",
          claim: phrase,
          message:
            `You wrote "${phrase}" as a product but no tool result this turn ` +
            `contains a product whose title starts with "${family}". ` +
            `Either remove that product mention or call a tool to surface it first.`,
        });
      }
    }
  }

  // 2. Price grounding.
  // A quoted dollar figure attached to a named product must match the
  // card's price (within reasonable rounding).
  const priceClaims = extractPriceClaims(text);
  for (const { phrase, family, price } of priceClaims) {
    const card = poolByFamily.get(family);
    if (!card) continue; // covered by rule 1
    const cardPriceStr = String(card.price_formatted || card.price || "").replace(/[^0-9.]/g, "");
    const cardPrice = parseFloat(cardPriceStr);
    if (!isFinite(cardPrice)) continue;
    if (Math.abs(cardPrice - price) > 0.5) {
      errors.push({
        kind: "wrong_price",
        claim: `${phrase} at $${price.toFixed(2)}`,
        actual: `$${cardPrice.toFixed(2)}`,
        message:
          `You wrote "${phrase}" at $${price.toFixed(2)} but the tool result ` +
          `shows that product at $${cardPrice.toFixed(2)}. Use the tool's price.`,
      });
    }
  }

  // 3. Feature grounding.
  // A feature/material claim tied to a specific product must be
  // supported by that card's description, tags, attributes, or claim
  // facts. This is the rule that catches "Noelle has both technologies
  // built in" — Noelle's card has no BioRocker/UltraSky evidence.
  // Skip on comparison turns: per-product distinctions ("X is sturdier than
  // Y for walking") read as unsupported claims and burn retries with no win.
  const isComparison = COMPARISON_RE.test(String(userMessage || ""));
  const featureClaims = isComparison ? [] : extractFeatureClaims(text);
  const seenFeatureClaims = new Set();
  for (const { family, productPhrase, feature } of featureClaims) {
    const key = `${family}|${feature}`;
    if (seenFeatureClaims.has(key)) continue;
    seenFeatureClaims.add(key);
    const card = poolByFamily.get(family);
    if (!card) continue; // already errored under rule 1
    if (!cardSupportsFeature(card, feature)) {
      errors.push({
        kind: "unsupported_feature_claim",
        claim: `${productPhrase} has ${feature}`,
        message:
          `You wrote that "${productPhrase}" has ${feature}, but the tool result ` +
          `for that product has no evidence of ${feature} (not in description, ` +
          `tags, attributes, or claim facts). Either drop that feature claim, ` +
          `pick a different product whose facts support it, or be honest that ` +
          `you're not certain.`,
      });
    }
  }

  // 4. False catalog denial. The model denied carrying a gender+category the
  // catalog actually has — reject so it corrects itself instead of misleading
  // the customer (and the response-contract having to silently rewrite it).
  if (categoryGenderMap) {
    const denial = detectFalseCatalogDenial(text, categoryGenderMap);
    if (denial) {
      const label = `${denial.gender === "men" ? "men's" : "women's"} ${String(denial.category).toLowerCase()}`;
      errors.push({
        kind: "false_catalog_denial",
        claim: `we don't carry ${label}`,
        message:
          `You wrote that we don't carry ${label}, but the catalog DOES carry ` +
          `${label}. Don't deny a category we stock. If a specific attribute ` +
          `(a color, size, or width) wasn't available, name THAT honestly — but ` +
          `present the ${label} we do have.`,
      });
    }
  }

  // 5. False color denial. The model told the customer a product doesn't
  // come in a color it actually offers — reject so it corrects itself
  // instead of suppressing a stocked variant (and costing a sale). Checked
  // against the card's own variant/colour evidence; honest denials of
  // genuinely-absent colors find no evidence and never fire.
  const colorDenials = detectFalseColorDenials(text, pool, poolByFamily);
  for (const { productPhrase, color } of colorDenials) {
    errors.push({
      kind: "false_color_denial",
      claim: `${productPhrase} doesn't come in ${color}`,
      message:
        `You wrote that "${productPhrase}" doesn't come in ${color}, but that ` +
        `product's own variant data lists ${color} as an available color. Don't ` +
        `deny a color we stock — present the ${color} option. If a different ` +
        `attribute (a size or width) was unavailable, name THAT honestly instead.`,
    });
  }

  // 6. Raw handle/slug leak. A customer-facing reply must never contain an
  // internal product handle/SKU slug ("jillian-cork-sc364w"). Cleanup can
  // strip a malformed draft down to one and the truth-checks above would
  // still pass it (a handle isn't a false claim). Reject so the model
  // rewrites with the real display name.
  const handleLeaks = detectRawHandleLeaks(text, pool);
  for (const slug of handleLeaks) {
    errors.push({
      kind: "raw_handle_leak",
      claim: slug,
      message:
        `You wrote "${slug}", which is a raw product handle/slug, not a ` +
        `customer-facing name. Rewrite using the product's real display ` +
        `title only (e.g. "Jillian Braided Quarter Strap Sandal") — never a ` +
        `hyphenated handle or SKU code.`,
    });
  }

  // ── Retail answer-contract rules (shape, not truth) ──────────────
  // Gated on a real customer message and a prod kill-switch. These run
  // last so a truth failure (which matters more) is reported first.
  const msg = String(userMessage || "").trim();
  if (msg && process.env.VALIDATOR_STYLE_RULES !== "off") {
    const isDecisionQ = DECISION_QUESTION_RE.test(msg);
    const wantsDetail = DETAIL_REQUEST_RE.test(msg);
    const isProductTurn = (pool && pool.length > 0) || isDecisionQ;
    const needsProductData = PRODUCT_DATA_INTENT_RE.test(msg);
    const poolEmpty = !pool || pool.length === 0;

    // 9. Missing product lookup. The customer named a specific product and
    // asked something that needs its real data (value/suitability/condition/
    // size), but the model answered WITHOUT fetching it — no search ran and
    // no product data is in the pool. Force a lookup. (Only when no search
    // was even attempted, so a genuinely-not-found product doesn't loop.)
    if (namedProductMentioned && needsProductData && poolEmpty && !searchAttempted) {
      errors.push({
        kind: "missing_product_lookup",
        claim: msg.slice(0, 80),
        message:
          "The customer asked about a specific product they named, but you " +
          "answered without looking it up — no product was fetched this turn. " +
          "Call get_product_details (or search_products) for that product " +
          "FIRST, then answer from its real attributes/variants. Never answer " +
          "a named-product value/fit/condition question from memory alone.",
      });
    }

    // 10. Generic fallback as a non-answer. A "browse these / take a look"
    // line is fine for a plain browse request, but it's a non-answer to a
    // specific value/suitability/sizing/availability question.
    if (needsProductData && GENERIC_FALLBACK_RE.test(text.trim())) {
      errors.push({
        kind: "generic_fallback_non_answer",
        claim: firstSentenceOf(text).slice(0, 80),
        message:
          "You replied with a generic 'browse these' line, but the customer " +
          "asked a specific question (value, suitability, sizing, or " +
          "availability). That's a non-answer. Answer it directly using the " +
          "product data you have; if you truly can't verify something, say " +
          "exactly what and offer to check it — never a generic 'take a look'.",
      });
    }

    // 7. Answer-first. A decision/suitability question must be answered in
    // the first sentence — not opened with generic listing/browse copy.
    if (isDecisionQ) {
      const lead = firstSentenceOf(text);
      if (GENERIC_LEAD_RE.test(lead)) {
        errors.push({
          kind: "answer_first",
          claim: lead.slice(0, 80),
          message:
            `The customer asked a direct question ("${msg.slice(0, 90)}") but your ` +
            `draft opens with generic browse copy ("${lead.slice(0, 60)}…"). Lead with ` +
            `a DIRECT answer in the first sentence (yes / no / it depends — and why), ` +
            `THEN mention products. Never open with "here are…" / "take a look…".`,
        });
      }
    }

    // 8. Overlong. A normal product/advisory answer must stay concise
    // unless the customer asked for depth (comparison, reviews, specs,
    // policy, "explain", "in detail", etc.). Capped on BOTH words and raw
    // characters — 160 words still overflows the narrow widget visually.
    // Comparison is a GOVERNED concise workflow: even though "compare/vs"
    // reads as a detail request, the contract caps it at ~120 words so it never
    // becomes a review essay. (A plain product turn uses the retail cap unless
    // the customer asked for depth.)
    const isComparison = workflow === "comparison";
    // condition_recommendation is governed TIGHTER than the generic retail cap
    // (Railway 2026-07-08: advisory turns kept shipping ~160-word drafts and
    // leaned on post-hoc trimming). Contract: 2-3 short sentences — pick(s) by
    // name, why they fit, one next step. ~90 words / 550 chars fits that shape
    // even with 2-3 full product titles; the kind is BLOCKING for this workflow
    // so the rewrite happens at the source (with a trim-and-ship valve at retry
    // exhaustion, never a handoff). The wantsDetail exemption still applies —
    // "explain in detail" advisory turns are not capped.
    const isConditionReco = workflow === "condition_recommendation";
    if (isProductTurn && (!wantsDetail || isComparison)) {
      const words = retailWordCount(text);
      const chars = text.trim().length;
      const maxWords = isComparison ? 120 : isConditionReco ? 90 : MAX_RETAIL_WORDS;
      const maxChars = isComparison ? 700 : isConditionReco ? 550 : MAX_RETAIL_CHARS;
      if (words > maxWords || chars > maxChars) {
        errors.push({
          kind: "too_long",
          claim: `${words} words / ${chars} chars`,
          message: isComparison
            ? `Your comparison draft is ${words} words — too long. Keep it under 120 ` +
              `words and 5 sentences: first sentence picks one product for the stated ` +
              `need and says why; then one short "choose the other if…"; at most 3 facts ` +
              `per side. No essay. Do NOT remove necessary caveats.`
            : isConditionReco
            ? `Your recommendation draft is ${words} words (${chars} characters) — too ` +
              `long. Rewrite it as 2-3 short sentences: (1) your direct pick(s) by name, ` +
              `(2) why they fit what the customer said, (3) optionally ONE next step or ` +
              `alternative. Name at most 2-3 products — exactly the ones shown. No preamble.`
            : `Your draft is ${words} words (${chars} characters) — too long for ` +
              `the chat widget. Rewrite it as a concise retail sales answer: answer ` +
              `directly in the first sentence, give one honest tradeoff, then one ` +
              `best next step. Keep it under 5 sentences and under ${MAX_RETAIL_CHARS} ` +
              `characters. Do NOT remove necessary caveats.`,
        });
      }
    }

    // 11. Fragment / non-answer. A real question or a card carousel demands
    // a substantive reply — an interjection-only opener ("Great question —",
    // "Absolutely —"), a dangling mid-thought, or an ultra-short blurb is a
    // non-answer. Product cards ALONE cannot make a fragment valid.
    const hasCards = pool && pool.length > 0;
    const hasSpecificQuestion = isDecisionQ || needsProductData;
    if (hasSpecificQuestion || hasCards) {
      const words = retailWordCount(text);
      const trimmed = text.trim();
      const isFragment =
        words < FRAGMENT_MIN_WORDS ||
        DANGLING_FRAGMENT_RE.test(trimmed) ||
        (isDecisionQ && words < MIN_DECISION_WORDS);
      if (isFragment) {
        errors.push({
          kind: "fragment_non_answer",
          claim: trimmed.slice(0, 80),
          message:
            `Your reply ("${trimmed.slice(0, 60)}…") is a fragment, not an answer. ` +
            `Write a complete, substantive reply that actually answers the ` +
            `customer in plain sentences — a direct answer, one reason/tradeoff, ` +
            `and a next step. Cards on their own are not an answer.`,
        });
      }
    }

    // 12. Sizing / availability must be answered in TEXT. A card carousel is
    // not an answer to "what size should I get?" If exact guidance isn't
    // available, give the best SAFE guidance in words.
    if (SIZING_AVAILABILITY_RE.test(msg) && !SIZING_ANSWERED_RE.test(text)) {
      errors.push({
        kind: "sizing_not_addressed",
        claim: firstSentenceOf(text).slice(0, 80),
        message:
          "The customer asked a sizing/availability question — answer it in " +
          "TEXT, not just with cards. If you can't confirm exact size/stock, " +
          "give the best safe guidance: start with their usual size, factor in " +
          "swelling/adjustable straps, mention easy returns or how it runs, or " +
          "ask whether they prefer a snug or roomy fit.",
      });
    }
  }

  // Answer-workflow non-answer (BLOCKING). For availability / comparison /
  // named-product / condition turns the customer is owed a real answer. A
  // generic "take a look / closest matches" line, a stock clarifier
  // ("men's or women's?", "tell me more", "what style/budget?"), or an empty
  // reply is a non-answer — force a synthesis retry rather than ship it.
  // Scoped to those workflows so plain browse/clarification turns are
  // untouched. Availability yes/no answers are short but real, so a reply is
  // only flagged when it MATCHES a fallback/clarifier shape, not merely short.
  if (ANSWER_WORKFLOW_NAMES.has(workflow)) {
    const t = text.trim();
    const isFallback = GENERIC_FALLBACK_RE.test(t);
    const isClarifierStall = PLAN_CLARIFIER_RE.test(t) && t.includes("?") && retailWordCount(t) <= 32;
    if (isFallback || isClarifierStall) {
      errors.push({
        kind: "answer_workflow_non_answer",
        claim: firstSentenceOf(t).slice(0, 80),
        message:
          `This is a ${workflow.replace(/_/g, " ")} turn — the customer is owed a direct answer, ` +
          `but your draft is a generic "${isFallback ? "take a look / closest matches" : "clarifying question"}" non-answer. ` +
          `Using the product evidence you have, answer the question directly: lead with the answer ` +
          `(yes/no for availability; a clear pick + the key tradeoff for comparison/advisory; a real ` +
          `recommendation for condition turns), then the cards follow. Do NOT ask men's-or-women's ` +
          `(assume the default line and say so) and never reply with "take a look" or "closest matches".`,
      });
    }
  }

  // SALES VOICE: the reply must read like a store associate, never narrate the
  // retrieval process ("I see I'm getting mostly sneakers… let me try one more
  // search", "I found results after filtering"). On sales-voiced workflows this
  // is BLOCKING — force a rewrite before it ever reaches the customer.
  const hasCards = Array.isArray(pool) && pool.length > 0;
  if (shouldBlockProcessNarration(workflow, hasCards)) {
    const narration = detectProcessNarration(text);
    if (narration.hit) {
      errors.push({
        kind: "process_narration",
        claim: String(narration.sentences[0] || "").slice(0, 80),
        message: PROCESS_NARRATION_RETRY_INSTRUCTION,
      });
    }
  }

  // ADVISORY QUALITY (BLOCKING on advisory workflows). Two failures that make an
  // answer read unlike a professional Aetrex associate:
  //   1. An unsupported MEDICAL claim — promising to cure/heal/fix/relieve/treat a
  //      foot condition. Aetrex sells comfort footwear/orthotics, not treatments,
  //      so this is a factual overreach; force a rewrite to honest comfort language.
  //   2. A WEAK non-answer — a "tell me more / what's the occasion" stall when the
  //      customer already gave a use case plus a category or condition. That's
  //      enough to recommend; another clarifier is a non-answer.
  if (ADVISORY_QUALITY_WORKFLOWS.has(workflow)) {
    const medical = detectUnsupportedMedicalClaim(text);
    if (medical.hit) {
      errors.push({
        kind: "unsupported_medical_claim",
        claim: String(medical.sentences[0] || "").slice(0, 80),
        message: MEDICAL_CLAIM_RETRY_INSTRUCTION,
      });
    }
    const weak = detectWeakNonAnswer({ text, message: userMessage, hasCards });
    if (weak.hit) {
      errors.push({
        kind: "advisory_weak_non_answer",
        claim: firstSentenceOf(text).slice(0, 80),
        message: WEAK_NON_ANSWER_RETRY_INSTRUCTION,
      });
    }
  }

  // COMPATIBILITY PRODUCT-TRUTH (BLOCKING). On a compatibility turn, an
  // unsupported orthotic↔sandal claim ("removable footbed", "orthotics drop into
  // sandals", "make room for the orthotic") with NO explicit catalog evidence of
  // an orthotic-compatible product is a fabricated product fact — reject and
  // force a rewrite to the Aetrex-safe answer (closed shoes / footwear with
  // removable insoles; for a sandal, built-in arch support). If the pool DOES
  // carry explicit removable-footbed/orthotic-compatible evidence, the claim is
  // allowed (only for that product), so no error.
  if (
    workflow === "compatibility" &&
    containsUnsupportedCompatibilityClaim(text) &&
    !hasExplicitOrthoticCompatibleEvidence(pool)
  ) {
    errors.push({
      kind: "unsupported_compatibility_claim",
      claim: firstSentenceOf(text).slice(0, 80),
      message:
        "You made an orthotic↔sandal compatibility claim (e.g. a removable footbed, " +
        "an orthotic dropping into a sandal, or making room for an orthotic) that NO " +
        "catalog evidence supports. Aetrex orthotics belong in closed shoes or footwear " +
        "with removable insoles/enough depth — never open sandals — and Aetrex sandals " +
        "have BUILT-IN arch support, not removable footbeds for orthotics. Rewrite to: \"" +
        buildOrthoticCompatibilityAnswer() + "\"",
    });
  }

  // Partition: only blocking (safety/factual) errors fail validation and
  // force a retry. Everything else is an observability warning — EXCEPT on
  // answer workflows, where a fragment, an unaddressed sizing question, or a
  // generic fallback is also a non-answer and must block (a 16-char reply can
  // never be "ok" for "what size should I get in Jillian?").
  const isAnswerWf = ANSWER_WORKFLOW_NAMES.has(workflow);
  const isBlocking = (e) =>
    BLOCKING_KINDS.has(e.kind) ||
    e.kind === "process_narration" ||
    // condition_recommendation is governed to 2-3 sentences at the SOURCE —
    // too_long blocks (rewrite before emit) instead of relying on a trim layer.
    (workflow === "condition_recommendation" && e.kind === "too_long") ||
    (isAnswerWf && ANSWER_WORKFLOW_BLOCKING_KINDS.has(e.kind));
  const blocking = errors.filter(isBlocking);
  const warnings = errors.filter((e) => !isBlocking(e));
  return { ok: blocking.length === 0, errors: blocking, warnings };
}

// Build the retry instruction text the agent loop hands back to the
// model when validation fails. Phrased as a clear correction request,
// not a rebuke — the model needs the facts to fix its answer.
//
// previousText: the failed draft. Included because runAgenticLoop does
// not return its internal messages array, so the retry conversation
// would otherwise reference "your previous reply" the model can't see.
// Compact, customer-safe evidence block built from the pool so a
// REWRITE-ONLY retry (tools disabled) still has the real product facts —
// the retry conversation re-runs from the original messages and does NOT
// carry tool results, so without this the model would rewrite from the
// failed draft alone. Handles/SKUs are deliberately omitted (the customer
// must never see them, and the raw_handle_leak rule would reject an echo).
function buildEvidenceSummary(pool = []) {
  const cards = (Array.isArray(pool) ? pool : []).slice(0, 6);
  const lines = [];
  for (const c of cards) {
    const title = String(c?.title || "").trim();
    if (!title) continue;
    const parts = [title];
    const price = c?.price_formatted || (c?.price != null && c?.price !== "" ? `$${c.price}` : "");
    if (price) parts.push(String(price));
    const colors =
      (c?._variantFacts && c._variantFacts.availableColors) ||
      c?.availableColors ||
      [];
    if (Array.isArray(colors) && colors.length) {
      parts.push(`colors: ${colors.slice(0, 8).join(", ")}`);
    }
    const facts = [];
    const cf = c?._claimFacts || {};
    for (const [k, v] of Object.entries(cf)) {
      const truthy = v === true || (v && v.value === true);
      if (truthy) facts.push(k);
    }
    if (facts.length) parts.push(facts.slice(0, 6).join(", "));
    lines.push(`- ${parts.join(" — ")}`);
  }
  if (!lines.length) return "";
  return [
    "Product evidence available to you THIS TURN (use these exact facts; do NOT invent details or show any handle/SKU):",
    ...lines,
  ].join("\n");
}

export function buildRetryInstruction(errors = [], previousText = "", pool = []) {
  if (!errors || errors.length === 0) return "";
  const lines = errors.slice(0, 4).map((e, i) => `${i + 1}. ${e.message}`);
  const evidence = buildEvidenceSummary(pool);
  const draftBlock = previousText
    ? [
        "Your previous draft (never shown to the customer):",
        '"""',
        String(previousText).slice(0, 1500),
        '"""',
        "",
      ]
    : [];
  // Style/voice-only failures (length/answer-first/process-narration) aren't
  // "factual issues" — frame the intro to fit whichever kind of error we hand
  // back. Process narration is a VOICE fix: the data is fine, only the phrasing
  // leaked the retrieval process.
  const STYLE_KINDS = new Set(["too_long", "answer_first", "raw_handle_leak", "process_narration"]);
  const allStyle = errors.every((e) => STYLE_KINDS.has(e.kind));
  const onlyNarration = errors.length > 0 && errors.every((e) => e.kind === "process_narration");
  const intro = onlyNarration
    ? "That draft narrated your process. Rewrite it as the polished, customer-facing answer:"
    : allStyle
    ? "That draft needs to be reshaped before it can go to the customer:"
    : "That draft has factual issues that need correcting before it can go to the customer:";
  return [
    ...draftBlock,
    intro,
    ...lines,
    ...(evidence ? ["", evidence] : []),
    "",
    "Rewrite the reply. If the only honest answer is that you can't verify the requested claim, say that plainly — that's a correct answer, not a failure.",
  ].join("\n");
}

// Test-only exports (named for clarity in eval files).
export const __TEST__ = {
  titleFamily,
  extractBoldedProductFamilies,
  extractPriceClaims,
  extractFeatureClaims,
  cardSupportsFeature,
  detectFalseCatalogDenial,
  detectFalseColorDenials,
  cardOffersColor,
  detectRawHandleLeaks,
  DECISION_QUESTION_RE,
  DETAIL_REQUEST_RE,
  GENERIC_LEAD_RE,
  PRODUCT_DATA_INTENT_RE,
  GENERIC_FALLBACK_RE,
  retailWordCount,
  firstSentenceOf,
};
