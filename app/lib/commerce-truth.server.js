// COMMERCE TRUTH — root-class detectors that make every product/card/fact answer
// truthful and aligned with the customer's request. Pure + testable; the chat
// route wires these as invariants (observe) and safe truth repairs (drop a
// mismatched card). This is NOT an ownership change — TurnPlan still owns the
// workflow; these only assert that whatever owner produced the cards told the
// truth about product type, variants, and evidence.
//
//   1. product_type_mismatch     — orthotics vs footwear (+ pivots / "only X")
//   2. variant_text_card_mismatch — text color/size ≠ shown card's variant
//   3. card_not_in_answer_evidence — a shown card isn't in the turn's evidence

import { parseCategoryConstraints } from "./chat-postprocessing.js";
import { isOrthoticProductCard, cardsNotInEvidencePool, textPresentsProducts } from "./turn-plan.server.js";
import { availabilityTextCardColorMismatch, cardColor, cardHasColor, findCardWithColor, claimedAvailabilityColors } from "./availability-truth.js";
import { answerNamesProductNotInEvidence } from "./turn-invariant.server.js";

const ORTHOTIC_TERM_RE = /\b(?:orthotics?|insoles?|inserts?|footbeds?|foot[\s-]*beds?|arch[\s-]support)\b/i;
const FOOTWEAR_TERM_RE = /\b(?:shoes?|sandals?|sneakers?|trainers?|boots?|booties?|loafers?|clogs?|slippers?|heels?|wedges?|flats?|mules?|slides?|pumps?|oxfords?|espadrilles?|moccasins?|footwear)\b/i;
// A rejection span — "not orthotics", "no insoles", "instead of orthotics",
// "don't want shoes", "rather than sneakers".
const REJECT_ORTHOTIC_RE = /\b(?:not|no|don'?t\s+want|without|instead\s+of|rather\s+than|other\s+than)\s+(?:the\s+|any\s+|an?\s+|my\s+)?(?:orthotics?|insoles?|inserts?|footbeds?|arch\s+support)\b/i;
const REJECT_FOOTWEAR_RE = /\b(?:not|no|don'?t\s+want|without|instead\s+of|rather\s+than|other\s+than)\s+(?:the\s+|any\s+|an?\s+|my\s+)?(?:shoes?|sandals?|sneakers?|boots?|loafers?|clogs?|heels?|wedges?|footwear)\b/i;
const EXCLUSIVE_RE = /\b(?:only|just|nothing\s+but)\b/i;

// Which product TYPE did the customer ask for this turn? Handles pivots
// ("not orthotics, show shoes instead") and exclusivity ("now only sandals").
export function requestedProductType(message) {
  const m = String(message || "");
  const cats = parseCategoryConstraints(m);
  const orthoticRejected = REJECT_ORTHOTIC_RE.test(m);
  const footwearRejected = REJECT_FOOTWEAR_RE.test(m);
  const orthoticPositive = ORTHOTIC_TERM_RE.test(m) && !orthoticRejected;
  const footwearPositive = (cats.positive.size > 0) || (FOOTWEAR_TERM_RE.test(m) && !footwearRejected);
  return {
    orthoticPositive,
    footwearPositive,
    orthoticRejected,
    footwearRejected,
    footwearCategories: cats.positive,
    exclusive: EXCLUSIVE_RE.test(m),
  };
}

function cardLabel(c) {
  return String(c?.title || c?.handle || "?");
}
function cardHay(c) {
  return `${String(c?.category || c?._category || c?.productType || "")} ${String(c?.title || "")}`.toLowerCase();
}
function cardMatchesCategory(card, catStem) {
  const stem = String(catStem || "").toLowerCase().replace(/s$/, "").replace(/[-\s]+/g, "");
  if (!stem) return true;
  const hay = cardHay(card).replace(/[-\s]+/g, "");
  if (!hay.trim()) return true; // no category info on the card → can't disprove
  return hay.includes(stem);
}

// INVARIANT detector (product_type_mismatch): the shown cards don't match the
// product TYPE the customer asked for. Returns a reason string, or null when the
// request is mixed/ambiguous or the cards are consistent. When no cards are
// shown, there is nothing to mis-show → null.
export function productTypeMismatch({ message = "", cards = [] } = {}) {
  const shown = Array.isArray(cards) ? cards : [];
  if (shown.length === 0) return null;
  const req = requestedProductType(message);
  const expectOrthotic = (req.orthoticPositive && !req.footwearPositive) || (req.footwearRejected && req.orthoticPositive);
  const expectFootwear = (req.footwearPositive && !req.orthoticPositive) || (req.orthoticRejected && req.footwearPositive);

  if (expectOrthotic) {
    const bad = shown.find((c) => !isOrthoticProductCard(c));
    return bad ? `footwear_card_on_orthotic_request:${cardLabel(bad)}` : null;
  }
  if (expectFootwear) {
    const orth = shown.find((c) => isOrthoticProductCard(c));
    if (orth) return `orthotic_card_on_footwear_request:${cardLabel(orth)}`;
    // Exclusive specific footwear category ("now only sandals") — every card
    // must be that category.
    if (req.exclusive && req.footwearCategories.size > 0) {
      const wrong = shown.find((c) => ![...req.footwearCategories].some((cat) => cardMatchesCategory(c, cat)));
      if (wrong) return `wrong_footwear_category:${cardLabel(wrong)}`;
    }
    return null;
  }
  return null;
}

// Repair helper: keep only the cards that match the requested product type.
// Used by the route as a safe truth repair (drops a mismatched card rather than
// ship a product that contradicts the request). Returns the filtered array.
export function filterCardsToRequestedType({ message = "", cards = [] } = {}) {
  const shown = Array.isArray(cards) ? cards : [];
  if (shown.length === 0) return shown;
  const req = requestedProductType(message);
  const expectOrthotic = (req.orthoticPositive && !req.footwearPositive) || (req.footwearRejected && req.orthoticPositive);
  const expectFootwear = (req.footwearPositive && !req.orthoticPositive) || (req.orthoticRejected && req.footwearPositive);
  if (expectOrthotic) return shown.filter((c) => isOrthoticProductCard(c));
  if (expectFootwear) {
    let out = shown.filter((c) => !isOrthoticProductCard(c));
    if (req.exclusive && req.footwearCategories.size > 0) {
      out = out.filter((c) => [...req.footwearCategories].some((cat) => cardMatchesCategory(c, cat)));
    }
    return out;
  }
  return shown;
}

// INVARIANT detector (variant_text_card_mismatch): the answer text asserts a
// color the shown card doesn't have (Rose text over a Denim card). Reuses the
// availability color-truth detector. Returns the mismatched color, or null.
export function variantTextCardMismatch({ text = "", cards = [], knownColors = [] } = {}) {
  return availabilityTextCardColorMismatch({ text, cards, knownColors });
}

// "similar alternatives" phrasing — when present, the answer is explicitly
// offering alternates, so extra (unnamed) cards are intentional.
const ALTERNATIVES_PHRASE_RE = /\b(?:similar|alternativ\w*|other\s+(?:options|styles|ones|pairs)|comparable|instead\s+you\s+(?:might|could)|closest\s+match(?:es)?|you\s+might\s+(?:also\s+)?like)\b/i;
export function answerAllowsAlternatives(text) {
  return ALTERNATIVES_PHRASE_RE.test(String(text || ""));
}

// INVARIANT detector (card_not_in_answer_evidence): a shown card is not inside
// this turn's evidence pool (a random/injected card). Returns the stray cards.
export function cardNotInAnswerEvidence({ finalCards = [], evidencePool = [] } = {}) {
  return cardsNotInEvidencePool({ finalCards, evidencePool });
}

// Convenience re-export so callers can do both alignment checks from one module.
export { answerNamesProductNotInEvidence };

// ─────────────────────────────────────────────────────────────────────────────
// ENFORCEMENT — repair/suppress bad output BEFORE the customer sees it. The
// detectors above only observe; enforceCommerceTruth() applies deterministic
// repairs so a truthful, request-aligned answer ships. Pure (no I/O): the chat
// route feeds it the turn's text/cards/evidence and swaps in the returned pair.
// ─────────────────────────────────────────────────────────────────────────────

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function cardKey(c) { return String(c?.handle || c?.title || "").toLowerCase(); }
function familyOf(c) {
  const fam = String(c?._family || c?.family || "").toLowerCase().trim();
  if (fam) return fam;
  return String(c?.title || "").trim().split(/\s+/)[0].toLowerCase();
}
function capitalize(s) { const t = String(s || ""); return t.charAt(0).toUpperCase() + t.slice(1); }

// Split into sentences and drop any that name the family (word-boundary).
function stripFamilySentences(text, family) {
  const fam = String(family || "").toLowerCase();
  if (!fam) return String(text || "");
  const re = new RegExp(`\\b${escapeRe(fam)}\\b`, "i");
  const kept = String(text || "").split(/(?<=[.!?])\s+/).filter((s) => !re.test(s));
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}

// Replace the promised color token with the actually-shown color (word-boundary).
function rewriteColorToken(text, fromColor, toColor) {
  return String(text || "").replace(new RegExp(`\\b${escapeRe(fromColor)}\\b`, "gi"), capitalize(toColor));
}

const NO_COLOR_TEXT = (color) =>
  `I'm not seeing that exact ${color ? `${color} ` : ""}color in the options I have here — want me to check what colors are available?`;
const SAFE_NO_CARD_TEXT =
  "I'm not seeing an exact match for that right now — want me to look at some close options?";

// THE commerce-truth enforcer. Returns { text, cards, repairs[] }. `repairs` is a
// list of { code, ... } so the caller can fire the matching invariants (the
// counters still record every repair). Order matters: drop stray/off-type cards
// first, then reconcile variant color, then reconcile named products, then the
// empty-card guard so we never ship product-listing copy with zero cards.
export function enforceCommerceTruth({
  message = "", text = "", cards = [], evidencePool = [], knownColors = [], knownFamilies = [], noCardText = "",
} = {}) {
  const repairs = [];
  let outCards = Array.isArray(cards) ? cards.slice() : [];
  let outText = String(text || "");
  const pool = Array.isArray(evidencePool) ? evidencePool : [];

  // 1. card_not_in_answer_evidence — a shown card outside this turn's evidence
  //    pool is a random/injected product. DROP it (blocking).
  if (outCards.length > 0 && pool.length > 0) {
    const stray = cardsNotInEvidencePool({ finalCards: outCards, evidencePool: pool });
    if (stray.length > 0) {
      const bad = new Set(stray.map(cardKey));
      outCards = outCards.filter((c) => !bad.has(cardKey(c)));
      repairs.push({ code: "card_not_in_answer_evidence", dropped: stray.length });
    }
  }

  // 2. product_type_mismatch — keep only cards of the requested product TYPE.
  if (outCards.length > 0) {
    const reason = productTypeMismatch({ message, cards: outCards });
    if (reason) {
      const before = outCards.length;
      outCards = filterCardsToRequestedType({ message, cards: outCards });
      repairs.push({ code: "product_type_mismatch", reason, dropped: before - outCards.length });
    }
  }

  // 3. variant_text_card_mismatch — the text promises a color no shown card has.
  //    Swap to the matching pool card → else rewrite the text to the shown color
  //    → else drop the card and answer honestly.
  if (outCards.length > 0) {
    for (const color of claimedAvailabilityColors({ text: outText, knownColors })) {
      if (outCards.some((c) => cardHasColor(c, color))) continue; // already truthful
      const poolMatch = findCardWithColor(pool, color);
      if (poolMatch) {
        const fam = familyOf(poolMatch);
        outCards = [poolMatch, ...outCards.filter((c) => familyOf(c) !== fam)];
        repairs.push({ code: "variant_text_card_mismatch", color, repair: "swapped_card" });
        continue;
      }
      const shownColor = outCards.map(cardColor).find(Boolean);
      if (shownColor) {
        outText = rewriteColorToken(outText, color, shownColor);
        repairs.push({ code: "variant_text_card_mismatch", color, repair: "rewrote_text", to: shownColor });
        continue;
      }
      outCards = [];
      outText = NO_COLOR_TEXT(color);
      repairs.push({ code: "variant_text_card_mismatch", color, repair: "dropped_honest" });
      break;
    }
  }

  // 4. answer_names_product_not_in_evidence — the copy names a product not shown.
  //    Show it if it's in the pool → else strip the sentence that names it.
  if (outCards.length > 0 && Array.isArray(knownFamilies) && knownFamilies.length > 0) {
    const named = answerNamesProductNotInEvidence({ text: outText, cards: outCards, knownFamilies });
    if (named) {
      const poolCard = pool.find((c) => familyOf(c) === String(named).toLowerCase());
      if (poolCard) {
        outCards = [poolCard, ...outCards.filter((c) => cardKey(c) !== cardKey(poolCard))];
        repairs.push({ code: "answer_names_product_not_in_evidence", family: named, repair: "showed_named" });
      } else {
        const stripped = stripFamilySentences(outText, named);
        outText = stripped.length >= 20 ? stripped : SAFE_NO_CARD_TEXT;
        repairs.push({ code: "answer_names_product_not_in_evidence", family: named, repair: "stripped_sentence" });
      }
    }
  }

  // 5. product_listing_without_cards — never ship "here are…" with zero cards.
  if (outCards.length === 0 && textPresentsProducts(outText)) {
    outText = noCardText || SAFE_NO_CARD_TEXT;
    repairs.push({ code: "product_listing_without_cards", repair: "text_replaced" });
  }

  return { text: outText, cards: outCards, repairs };
}
