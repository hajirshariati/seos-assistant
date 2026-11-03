// Deals — the instant card behind the "Deals" pill (no AI at tap time):
// the offers running right now, then the products on sale.
//
// Offers come from the store's own words: the promotions page (Settings →
// Shopping tools → Promotions page) and dated campaigns. The page's text is
// turned into short offer lines once per change of the page (a small model,
// deals.server.js), and every line it returns is checked against the page:
// a title whose words aren't on the page, or a code that isn't written
// there, is dropped — the card never shows an offer the store didn't.
// Without a key, the page's lines are shown as they are.
//
// Products on sale: the catalog's compare-at price against its price, best
// discount first, one card per style. Pure rules; no network.

export const MAX_OFFERS = 6;
export const MAX_PRODUCTS = 8;
export const OFFER_MAX = { title: 60, detail: 140, code: 24, ends: 40 };

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Settings → Shopping tools → Deals.
export function dealsConfig(config = {}) {
  if (config.dealsCardOn === false) return null;
  const url = /^https?:\/\/[^\s"'<>]+$|^\/[^\s"'<>]*$/i.test(String(config.dealsUrl || "").trim()) ? String(config.dealsUrl).trim() : "";
  return { on: true, label: "Deals", url };
}

// Discount, as a share of the compare-at price (0 when not on sale).
export const discountShare = (p) => (p?.onSale && Number.isFinite(p.compareAtPrice) && p.compareAtPrice > 0 && Number.isFinite(p.price) ? (p.compareAtPrice - p.price) / p.compareAtPrice : 0);

// The products on sale, best discount first, one per style, in stock only.
export function saleProducts(catalog, { limit = MAX_PRODUCTS } = {}) {
  const seen = new Set();
  return (catalog?.products || [])
    .filter((p) => p.onSale && p.inStock !== false && discountShare(p) > 0)
    .sort((a, b) => discountShare(b) - discountShare(a) || a.price - b.price || String(a.title).localeCompare(String(b.title)))
    .filter((p) => { const k = String(p.style || p.title).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, limit);
}

// A dated campaign as an offer: its name, its first line, its end.
export function offerFromCampaign(c) {
  const name = String(c?.name || "").trim();
  // The first line that isn't the name again (a heading repeating it).
  const first = String(c?.content || "").split(/\n/).map((l) => l.replace(/^[#*\-–—•\s]+/, "").trim()).find((l) => l && l.toLowerCase() !== name.toLowerCase()) || "";
  return { title: clean(name, OFFER_MAX.title), detail: clean(first, OFFER_MAX.detail), code: "", ends: c?.endsAt ? new Date(c.endsAt).toISOString() : "" };
}

// Without a model: the page's own lines, as they are.
export function offersFromLines(lines = []) {
  return lines.slice(0, MAX_OFFERS).map((l) => ({ title: clean(l, 90), detail: "", code: "", ends: "" }));
}

const WORD = /[a-z0-9%$]+/g;
const STOP = new Set(["the", "and", "for", "with", "your", "you", "off", "on", "of", "a", "an", "to", "in", "is", "it", "all", "any", "at", "or", "get", "free", "sale", "offer", "code", "use", "now", "our"]);
const words = (s) => (String(s || "").toLowerCase().match(WORD) || []).filter((w) => w.length > 2 && !STOP.has(w));
// Every number, percentage or amount, whatever its length ("30", "$75", "11/2").
const numbers = (s) => (String(s || "").toLowerCase().match(/[$]?\d[\d.,/%-]*%?/g) || []).map((n) => n.replace(/[.,]+$/, ""));

// Only what the page says: a title whose key words are on the page (every
// word with a digit or a sign — 20%, $75 — plus most of the rest), a code
// written there as is, an end date written there. Else the offer is dropped.
export function validateOffers(list, sourceText, { max = MAX_OFFERS } = {}) {
  const src = String(sourceText || "").toLowerCase();
  const srcWords = new Set(words(src));
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const o = { title: clean(raw?.title, OFFER_MAX.title), detail: clean(raw?.detail, OFFER_MAX.detail), code: clean(raw?.code, OFFER_MAX.code).replace(/\s+/g, ""), ends: clean(raw?.ends, OFFER_MAX.ends) };
    if (!o.title) continue;
    const tw = words(o.title);
    if (!tw.length) continue;
    if (numbers(o.title).some((n) => !src.includes(n))) continue;
    const hits = tw.filter((w) => srcWords.has(w)).length;
    if (hits < Math.max(1, Math.ceil(tw.length * 0.6))) continue;
    if (o.code && !src.includes(o.code.toLowerCase())) continue;
    if (o.detail && numbers(o.detail).some((n) => !src.includes(n))) o.detail = "";
    if (o.ends && (!/\d/.test(o.ends) || numbers(o.ends).some((n) => !src.includes(n)))) o.ends = "";
    if (out.some((x) => x.title.toLowerCase() === o.title.toLowerCase())) continue;
    out.push(o);
    if (out.length >= max) break;
  }
  return out;
}

// The question to the small model: the page's text → short offer lines, JSON.
export function structurePrompt(text) {
  return [
    "Below is the promotions section of a store's page. Rewrite it as a JSON array of the offers it lists — nothing that isn't written there.",
    "Each item: {\"title\": up to 8 words naming the offer (keep every number, percentage, dollar amount and product name as written), \"detail\": one short line of how to get it or what it covers (or \"\"), \"code\": the discount code exactly as written (or \"\"), \"ends\": the end date or time exactly as written (or \"\")}.",
    "Rules: never add an offer, a code, an amount or a date that isn't in the text; skip legal terms, exclusions-only lines and anything that isn't an offer; at most 6 items; answer with the JSON array only.",
    "",
    "TEXT:",
    String(text || "").slice(0, 6000),
  ].join("\n");
}

export function parseStructured(answer) {
  const s = String(answer || "");
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try { const v = JSON.parse(s.slice(start, end + 1)); return Array.isArray(v) ? v : []; } catch { return []; }
}

// A short day for an ISO end ("Nov 9"); other wording kept as written.
export function endsWords(ends) {
  const s = String(ends || "").trim();
  if (!s) return "";
  const d = /^\d{4}-\d{2}-\d{2}T/.test(s) ? new Date(s) : null;
  if (d && !isNaN(+d)) return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
  return s;
}
