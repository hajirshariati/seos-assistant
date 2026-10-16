// Use-case → catalog search terms. "dress" is an OCCASION, and catalogs rarely
// say "dress shoe" — they carry wedges, Mary Janes, loafers, oxfords, ballet
// flats tagged for social/office wear. A bare "dress footwear" query matched
// casual slip-ons and flip-flops (live trace 2026-10-16). Expand only use
// cases whose word never appears on the products themselves; "heel" is
// deliberately absent (it matches every "Heel Pain" tag).
const USE_CASE_SEARCH_TERMS = {
  dress: "dressy wedge mary jane loafer oxford ballet social",
};

export function useCaseSearchTerms(useCase) {
  const key = String(useCase || "").toLowerCase().trim();
  if (!key) return "";
  return USE_CASE_SEARCH_TERMS[key] || key;
}

// The customer asked for dress/formal footwear THIS turn ("a dress shoe",
// "something for a wedding") — not just mentioned the dress they're wearing.
export const DRESS_FOOTWEAR_ASK_RE =
  /\b(?:dress(?:y)?\s+(?:shoes?|footwear|sandals?|flats?|options?|styles?|pairs?)|dressy|formal|wedding|gala|cocktail)\b/i;
