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
  seenProducts = [],      // products the reply may name: found this turn or shown before
  freshProducts = null,   // found this turn and not shown to the customer before
  priorTitles = [],       // titles shown in earlier turns (history)
  familyIndex = new Map(),
  knowledgeText = "",     // store info, promotions, order/review/recommender tool output this turn
} = {}) {
  const issues = [];
  const body = String(text || "");

  const seenFamilies = new Set(
    [...seenProducts.map((p) => p.style), ...priorTitles].map((t) => styleFamily(t)).filter(Boolean),
  );
  // A product named in tool output (an order's line items, a review summary,
  // store info) is a fact the customer can be told about.
  for (const family of familyIndex.keys()) {
    if (knowledgeText && new RegExp(`(^|[^A-Za-z])${family}([^A-Za-z]|$)`).test(knowledgeText)) seenFamilies.add(family);
  }

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

  // 3. Recommending products found this turn → show their cards. Products the
  // customer has already seen as cards can be talked about without re-showing.
  const recommendsSeen = (freshProducts || seenProducts).some((p) => {
    const f = styleFamily(p.style);
    return f && new RegExp(`(^|[^A-Za-z])${f}([^A-Za-z]|$)`).test(body);
  });
  if (recommendsSeen && shownHandles.length === 0) {
    issues.push({ code: "missing_cards", detail: "You named products but didn't call show_products. Show the ones you recommend." });
  }

  // 4. Discounts and promo codes must come from the store (promotions,
  // store info, tool output) — an invented "20% off" or code costs money.
  const known = String(knowledgeText || "").toLowerCase();
  const badOffers = [];
  for (const m of body.matchAll(/(\d{1,2})\s?%\s?off\b/gi)) {
    if (!new RegExp(`\\b${m[1]}\\s?%`).test(known)) badOffers.push(m[0]);
  }
  for (const m of body.matchAll(/\b(?:code|coupon)\s*:?\s*["“']?([A-Z0-9][A-Z0-9-]{3,})\b/g)) {
    if (/[A-Z]/.test(m[1]) && /\d|[A-Z]{4,}/.test(m[1]) && !known.includes(m[1].toLowerCase())) badOffers.push(m[1]);
  }
  if (badOffers.length) {
    issues.push({ code: "unverified_offer", detail: `These offers aren't in the store's promotions or info: ${[...new Set(badOffers)].join(", ")}. Only mention discounts and codes the store lists.` });
  }

  return issues;
}

// The store's product lines, as people name them: a shoe by its first word
// ("Chase"), an orthotic by the words before "Orthotics" ("Speed",
// "Premium Memory Foam", "Extreme Comfort"). Longest first.
const LINE_DROP = /\b(posted|orthotics?|insoles?|w\/.*|with .*|first generation|customizable)\b/gi;
export function productLineNames(products = []) {
  const names = new Set();
  for (const p of products) {
    const title = String(p.title || "");
    if (/orthotic/i.test(title)) {
      const head = title.split(/\s[-–—]\s/)[0].split(/\borthotics?\b/i)[0];
      const words = head.split(/\s+/).filter((w) => w && !GENERIC_FIRST_WORDS.has(w.toLowerCase().replace(/[^a-z'’]/g, "")));
      const line = words.join(" ").replace(LINE_DROP, " ").replace(/\s+/g, " ").trim();
      if (line.length >= 4) names.add(line);
    } else {
      const f = styleFamily(p.style || title);
      if (f) names.add(f);
    }
  }
  return [...names].sort((a, b) => b.length - a.length);
}

const FREE_SHIP = /\bfree\b[^.!?\n]{0,40}\b(ship(ping)?|delivery)\b|\bships?\s+(for\s+)?free\b/i;
const ENDED = /\b(has ended|ended on|expired|no longer)\b/i;
const wordRe = (w) => new RegExp(`(^|[^a-z])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`);

// 5. Free shipping said of a product the store's offer doesn't name: the
// offer covers certain orthotics, the reply says the Speed ships free. Only
// when every free-shipping offer the store gave names its products (a
// store-wide one may well cover the product). → [{ line, offers }] or [].
export function misappliedShipping({ text = "", knowledgeText = "", lineNames = [] } = {}) {
  const storeLines = String(knowledgeText || "").split(/\n/).filter((l) => FREE_SHIP.test(l) && !ENDED.test(l));
  const mentions = (sentence) => {
    let rest = ` ${sentence.toLowerCase()} `;
    const found = [];
    for (const n of lineNames) {
      const re = wordRe(n);
      if (re.test(rest)) { found.push(n); rest = rest.replace(new RegExp(re.source, "g"), "$1 $2"); }
    }
    return found;
  };
  const offers = storeLines.map((l) => ({ text: l.trim(), lines: mentions(l) }));
  if (!offers.length || offers.some((o) => o.lines.length === 0)) return [];
  const named = new Set(offers.flatMap((o) => o.lines.map((n) => n.toLowerCase())));
  const out = [];
  for (const sentence of String(text || "").split(/(?<=[.!?])\s+|\n+/)) {
    if (!FREE_SHIP.test(sentence)) continue;
    for (const n of mentions(sentence)) {
      if (!named.has(n.toLowerCase()) && !out.some((x) => x.line === n)) out.push({ line: n, offers: offers.map((o) => o.text) });
    }
  }
  return out;
}
