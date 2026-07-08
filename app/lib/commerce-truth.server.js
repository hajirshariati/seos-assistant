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
import { isOrthoticProductCard, cardsNotInEvidencePool } from "./turn-plan.server.js";
import { availabilityTextCardColorMismatch } from "./availability-truth.js";
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
