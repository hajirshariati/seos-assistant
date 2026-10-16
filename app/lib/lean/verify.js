// Lean engine — fact check. Checks only what can be verified against data:
// named products were actually found, prices are real, recommended products
// get cards. It never edits wording; failures go back to Claude to rewrite.
// Pure.

const GENERIC_FIRST_WORDS = new Set([
  "women's", "womens", "men's", "mens", "unisex", "kids", "kid's", "boy's", "boys", "girl's", "girls",
  "children's", "childrens", "the", "new", "classic", "aetrex",
]);

// First word of a style name is how people refer to it ("the Savannah").
export function styleFamily(style) {
  const first = String(style || "").trim().split(/\s+/)[0] || "";
  const clean = first.replace(/[^A-Za-z'’-]/g, "");
  if (clean.length < 4 || GENERIC_FIRST_WORDS.has(clean.toLowerCase())) return "";
  return clean;
}

export function buildFamilyIndex(products = []) {
  const index = new Map(); // family → Set(handle)
  for (const p of products) {
    const f = styleFamily(p.style);
    if (!f) continue;
    if (!index.has(f)) index.set(f, new Set());
    index.get(f).add(p.handle);
  }
  return index;
}

const PRICE_RE = /\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/g;

export function verifyLeanAnswer({
  text = "",
  shownHandles = [],
  seenProducts = [],      // products returned by tools this turn (catalog products)
  priorTitles = [],       // titles shown in earlier turns (history)
  familyIndex = new Map(),
  knowledgeText = "",     // text returned by search_store_info this turn
} = {}) {
  const issues = [];
  const body = String(text || "");

  const seenFamilies = new Set(
    [...seenProducts.map((p) => p.style), ...priorTitles].map((t) => styleFamily(t)).filter(Boolean),
  );

  // 1. Named products must have been found this conversation.
  const unverified = [];
  for (const family of familyIndex.keys()) {
    if (seenFamilies.has(family)) continue;
    if (new RegExp(`(^|[^A-Za-z])${family}([^A-Za-z]|$)`).test(body)) unverified.push(family);
  }
  if (unverified.length) {
    issues.push({
      code: "unverified_product",
      detail: `You mentioned ${unverified.join(", ")} without finding ${unverified.length > 1 ? "them" : "it"} with a tool in this conversation. Search for it first, or don't mention it.`,
    });
  }

  // 2. Prices must be real.
  const allowed = new Set();
  for (const p of seenProducts) {
    for (const n of [p.price, p.maxPrice, p.compareAtPrice]) if (Number.isFinite(n)) allowed.add(n.toFixed(2));
  }
  for (const m of String(knowledgeText || "").matchAll(PRICE_RE)) allowed.add(Number(m[1].replace(/,/g, "")).toFixed(2));
  for (const t of priorTitles) for (const m of String(t).matchAll(PRICE_RE)) allowed.add(Number(m[1].replace(/,/g, "")).toFixed(2));
  const badPrices = [...body.matchAll(PRICE_RE)]
    .map((m) => Number(m[1].replace(/,/g, "")).toFixed(2))
    .filter((v) => !allowed.has(v));
  if (badPrices.length) {
    issues.push({ code: "unverified_price", detail: `These prices don't match any product or store info you looked up: ${[...new Set(badPrices)].map((v) => `$${v}`).join(", ")}.` });
  }

  // 3. Recommending products found this turn → show their cards.
  const recommendsSeen = seenProducts.some((p) => {
    const f = styleFamily(p.style);
    return f && new RegExp(`(^|[^A-Za-z])${f}([^A-Za-z]|$)`).test(body);
  });
  if (recommendsSeen && shownHandles.length === 0) {
    issues.push({ code: "missing_cards", detail: "You named products but didn't call show_products. Show the ones you recommend." });
  }

  return issues;
}
