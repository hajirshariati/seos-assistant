// Memory — ended offers and retired styles, from the store's own records only.
//
// Offers: every read of the promotions page (promo-page.server.js) is split
// into offer lines and compared with the lines still open in PromoMemory.
// A line that is gone is marked ended at that read; a line that merely
// changed a few words (a typo fixed) is carried over, not ended. Dated
// campaigns (Knowledge → Campaigns) are remembered with their own end date.
// The chat looks past offers up by the customer's words and says only what
// the record says: ended, with its date — or "no record".
//
// Styles: a product that is archived, set to draft or deleted is copied to
// RetiredProduct before it goes (Product.server.js). A typed style name
// that matches none of the live styles but one of the retired ones gets a
// note so the chat can say it was discontinued, and when, and show what's
// sold now. The product coming back closes the row.
//
// Pure rules; the database work is in the models.
import { styleName } from "./lean/catalog.js";
import { dayKeyIn } from "./store-day.js";

export const PROMO_DAYS_CHOICES = [30, 60, 90, 180, 365];
export const STYLE_DAYS_CHOICES = [180, 365, 730, 1095];
export const promoMemoryDays = (v) => (PROMO_DAYS_CHOICES.includes(Number(v)) ? Number(v) : 90);
export const styleMemoryDays = (v) => (STYLE_DAYS_CHOICES.includes(Number(v)) ? Number(v) : 730);
export const DAY_MS = 24 * 60 * 60 * 1000;
// The time zone the memory's dates are told in: the same one the chat's
// date note leads with (Eastern), so "yesterday" means the same thing.
export const MEMORY_TZ = "America/New_York";

// ── Offers ──────────────────────────────────────────────────────────────

const LINE_MIN = 12;
const LINE_MAX = 300;
const LINES_MAX = 60;

// The offer lines of the promotions section: one per line of text, three
// words or more, trimmed, without bullets, no repeats. Headings ("CURRENT
// OFFERS") are too short to count.
export function promoLines(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || "").split(/\n+/)) {
    const line = raw.replace(/\s+/g, " ").trim().replace(/^[-•*·▪●]+\s*/, "");
    if (line.length < LINE_MIN || line.split(" ").length < 3) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line.slice(0, LINE_MAX));
    if (out.length >= LINES_MAX) break;
  }
  return out;
}

const lineKey = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const wordSet = (s) => new Set(lineKey(s).split(/[^a-z0-9%$]+/).filter((w) => w.length > 1));

// How alike two lines are (shared words over all words): 1 = the same.
export function lineSimilarity(a, b) {
  const x = wordSet(a), y = wordSet(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

const EDIT_MIN = 0.7;

// The open lines against this read's lines → what stayed, what's new, what
// ended, and lines that were only edited ({ from, to }: the old row is
// renamed, its first-seen kept, nothing ends).
export function diffPromoLines(openTexts = [], lines = []) {
  const openKeys = new Map(openTexts.map((t) => [lineKey(t), t]));
  const nowKeys = new Map(lines.map((l) => [lineKey(l), l]));
  const kept = [];
  let gone = [];
  for (const [k, t] of openKeys) (nowKeys.has(k) ? kept : gone).push(t);
  let started = lines.filter((l) => !openKeys.has(lineKey(l)));
  const edited = [];
  for (const g of [...gone]) {
    let best = null, bestScore = 0;
    for (const s of started) {
      const score = lineSimilarity(g, s);
      if (score > bestScore) { best = s; bestScore = score; }
    }
    if (best && bestScore >= EDIT_MIN) {
      edited.push({ from: g, to: best });
      gone = gone.filter((t) => t !== g);
      started = started.filter((t) => t !== best);
    }
  }
  return { kept, started, ended: gone, edited };
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "your", "you", "off", "on", "of", "a", "an", "to", "in", "is", "it", "this", "that", "was",
  "there", "get", "any", "all", "have", "has", "had", "still", "code", "promo", "promotion", "sale", "deal", "deals",
  "offer", "offers", "discount", "email", "about", "my", "me", "do", "does", "did", "can", "could", "would", "will",
  "when", "what", "how", "are", "were", "from", "got", "saw", "see", "sent", "yesterday", "today", "last", "week",
  "running", "valid", "work", "works", "working", "expired", "ended", "end", "over", "use", "apply", "applied",
  "order", "orders", "buy", "shop", "shopping", "store", "site", "website", "purchase", "receive", "received",
  "free", "percent", "dollars", "dollar", "price", "prices", "cart", "checkout", "one", "two", "some", "more",
  "want", "wanted", "like", "need", "please", "hi", "hello", "hey", "thanks", "thank", "know", "tell", "think",
]);

// The words of a question worth matching against offer lines: three
// letters or more, not filler; codes and amounts ("SAVE20", "20%") kept.
export function offerWords(query) {
  const out = [];
  for (const raw of String(query || "").split(/[^A-Za-z0-9%$]+/)) {
    const w = raw.trim();
    if (!w) continue;
    const key = w.toLowerCase();
    if (/\d/.test(w)) { if (!out.includes(key)) out.push(key); continue; }
    if (key.length < 3 || STOP_WORDS.has(key)) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out.slice(0, 12);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// How many of the words an offer line has (whole words, any case); a code
// written in capitals that appears as is counts double.
export function scoreOffer(text, words = []) {
  const t = ` ${String(text || "").toLowerCase()} `;
  let score = 0;
  for (const w of words) {
    if (new RegExp(`(^|[^a-z0-9])${esc(w)}([^a-z0-9]|$)`).test(t)) score += /\d/.test(w) || w.length >= 6 ? 2 : 1;
  }
  return score;
}

// The remembered offers that match the customer's words: the ones still
// running first (so an edited line is never reported as ended), then the
// ended ones within the memory window, best match first, three of each.
export function matchOffers(rows = [], query, { now = Date.now(), days = 90, limit = 3 } = {}) {
  const words = offerWords(query);
  if (!words.length) return { words, running: [], ended: [] };
  const since = now - days * DAY_MS;
  const scored = rows
    .map((r) => ({ row: r, score: scoreOffer(r.text, words) }))
    .filter((x) => x.score > 0 && (!x.row.endedAt || new Date(x.row.endedAt).getTime() >= since));
  const byBest = (a, b) => b.score - a.score || new Date(b.row.lastSeenAt) - new Date(a.row.lastSeenAt);
  return {
    words,
    running: scored.filter((x) => !x.row.endedAt).sort(byBest).slice(0, limit).map((x) => x.row),
    ended: scored.filter((x) => x.row.endedAt).sort(byBest).slice(0, limit).map((x) => x.row),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayWords(key) {
  const m = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  return `${MONTHS[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}
// Whole calendar days between two moments, in the store's time zone.
const keyNumber = (k) => { const m = String(k).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS : 0; };
export const daysBetween = (a, b, tz = "") => { const key = dayKeyIn(tz); return Math.round(keyNumber(key(new Date(b))) - keyNumber(key(new Date(a)))); };

// What the chat may say about an ended offer: the day it ended — when the
// page was last seen with it on the same day a read lacked it — or, when
// the reads were a day or more apart, the last day it was seen on and that
// it has ended since. Plus how many days ago, so "yesterday" is exact.
export function endedWording(row, { tz = "", now = Date.now() } = {}) {
  const key = dayKeyIn(tz);
  const last = key(new Date(row.lastSeenAt));
  const ended = row.endedAt ? key(new Date(row.endedAt)) : "";
  if (!ended) return { status: "running", words: "still running" };
  const sameDay = last === ended;
  const ago = Math.max(0, daysBetween(row.endedAt, now, tz));
  const agoWords = ago === 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`;
  return {
    status: "ended",
    endedOn: ended,
    lastSeenOn: last,
    daysAgo: ago,
    words: sameDay ? `ended on ${dayWords(ended)} (${agoWords})` : `was still on through ${dayWords(last)} and had ended by ${dayWords(ended)} (${agoWords})`,
  };
}

// The tool's answer for the model.
export function pastOffersResult(match, { tz = "", now = Date.now(), days = 90 } = {}) {
  const running = match.running.map((r) => ({ offer: r.text, status: "running now" }));
  const ended = match.ended.map((r) => {
    const w = endedWording(r, { tz, now });
    return { offer: r.text, status: "ended", when: w.words, first_seen: dayWords(dayKeyIn(tz)(new Date(r.firstSeenAt))), days_ago: w.daysAgo };
  });
  const note = running.length
    ? "A matching offer is running now — it's under ACTIVE PROMOTIONS / the promotions page; answer from that, don't call it ended."
    : ended.length
      ? "These are the store's own records of offers it showed, with the day each was last shown. Tell the customer the offer has ended, using \"when\" as given (never another date), then what's running now (ACTIVE PROMOTIONS / the promotions page) so they have an option. Don't promise an extension or a code."
      : `No remembered offer matches those words (the store keeps ended offers for ${days} days). Say plainly you don't have a record of that offer — don't guess whether it existed or when it ended — and share what's running now.`;
  return { words_looked_for: match.words, running: running.length ? running : undefined, ended: ended.length ? ended : undefined, note };
}

// ── Styles ──────────────────────────────────────────────────────────────

const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
function readCI(attrs, keys) {
  const out = [];
  for (const [k, v] of Object.entries(attrs || {})) {
    if (!keys.includes(String(k).toLowerCase())) continue;
    for (const x of list(v)) if (x != null && String(x).trim()) out.push(String(x).trim());
  }
  return out;
}
const parseJson = (v) => { if (v && typeof v === "object") return v; try { return JSON.parse(v); } catch { return null; } };

export const RETIRE_REASONS = { archived: "archived", draft: "draft", deleted: "deleted" };
export function retireReason(status) {
  const s = String(status || "").toLowerCase();
  return s === "archived" ? "archived" : s === "draft" ? "draft" : "";
}

// A RetiredProduct row from the catalog row that is about to go.
export function retiredRowFromProduct(row, reason = "archived") {
  const attrs = parseJson(row.attributesJson) || {};
  const category = String(readCI(attrs, ["category_for_filter", "category"])[0] || row.productType || "").trim().slice(0, 80);
  const gender = String(readCI(attrs, ["gender", "genders", "gender_fallback"])[0] || "").trim().toLowerCase().slice(0, 20);
  return {
    shopifyId: String(row.shopifyId || ""),
    handle: String(row.handle || "").slice(0, 255),
    title: String(row.title || "").slice(0, 255),
    style: styleName(row.title).slice(0, 255),
    productType: String(row.productType || "").slice(0, 80),
    gender,
    category,
    imageUrl: /^https:\/\//.test(String(row.featuredImageUrl || "")) ? String(row.featuredImageUrl).slice(0, 1000) : "",
    reason: RETIRE_REASONS[reason] || "archived",
  };
}

// "Blake - Black" → "Black" (the colorway suffix of a product title).
export const titleColor = (title) => {
  const m = String(title || "").match(/\s+[-–—]\s+([^-–—]+)$/);
  return m ? m[1].trim() : "";
};

const firstWord = (style) => String(style || "").trim().split(/\s+/)[0]?.replace(/[^A-Za-z'’-]/g, "") || "";

// The first words of the live footwear styles (any colorway in stock): a
// retired style with the same name is a colorway question, not a goner.
export function liveStyleKeys(catalog) {
  const keys = new Set();
  for (const p of catalog?.products || []) {
    const w = firstWord(p.style).toLowerCase();
    if (w.length >= 4) keys.add(w);
  }
  return keys;
}

// Retired rows → Map of first word → { name, styles: [{ style, colors, reason, retiredAt }] },
// leaving out names the live catalog still has, generic words and vocabulary.
export function retiredStyleIndex(rows = [], { liveKeys = new Set(), generic = new Set(), vocab = new Set() } = {}) {
  const idx = new Map();
  for (const r of rows) {
    if (r.returnedAt) continue;
    const name = firstWord(r.style || r.title);
    const key = name.toLowerCase();
    if (name.length < 4 || liveKeys.has(key) || generic.has(key) || vocab.has(key)) continue;
    if (!idx.has(key)) idx.set(key, { name, styles: new Map() });
    const styles = idx.get(key).styles;
    const style = r.style || styleName(r.title);
    if (!styles.has(style)) styles.set(style, { style, colors: [], reason: r.reason, retiredAt: r.retiredAt, gender: r.gender || "", category: r.category || r.productType || "" });
    const s = styles.get(style);
    const color = titleColor(r.title);
    if (color && !s.colors.includes(color)) s.colors.push(color);
    if (new Date(r.retiredAt) > new Date(s.retiredAt)) { s.retiredAt = r.retiredAt; s.reason = r.reason; }
  }
  return idx;
}

// The retired style names in a message.
export function retiredStylesInText(idx, text) {
  if (!idx?.size) return [];
  const words = String(text || "").toLowerCase().replace(/[’']s\b/g, "").split(/[^a-z'’-]+/).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const w of words) {
    const hit = idx.get(w);
    if (!hit || seen.has(w)) continue;
    seen.add(w);
    out.push({ name: hit.name, styles: [...hit.styles.values()] });
  }
  return out;
}

const REASON_WORDS = { archived: "discontinued", deleted: "discontinued", draft: "not sold right now (it may come back)" };

// The note under the customer's message: the store's own record of the
// style, what to say, and what to show instead.
export function retiredNote(hits = [], { tz = "", now = Date.now() } = {}) {
  if (!hits.length) return "";
  const key = dayKeyIn(tz);
  const lines = hits.map((h) => {
    const parts = h.styles.slice(0, 3).map((s) => {
      const what = [s.gender, s.category].filter(Boolean).join(" ");
      const ago = Math.max(0, daysBetween(s.retiredAt, now, tz));
      return `"${s.style}"${what ? ` (${what})` : ""} — ${REASON_WORDS[s.reason] || "discontinued"}; left the store on ${dayWords(key(new Date(s.retiredAt)))} (${ago === 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`})${s.colors.length ? `; it came in ${s.colors.slice(0, 6).join(", ")}` : ""}`;
    });
    return `${h.name}: ${parts.join("; ")}.`;
  });
  return `(RETIRED STYLE — the store's own record, the only source for this: ${lines.join(" ")} Say so plainly and warmly — it was in the line-up and is ${hits.every((h) => h.styles.every((s) => s.reason === "draft")) ? "not sold right now" : "no longer sold"} — with the date given; don't offer to check stock or set an alert for it, and never guess why. Then show the closest styles sold now (search_products for the same kind, e.g. the same gender and category) so they have somewhere to go.)`;
}

// A reply that says an offer ended or a style is gone — only the store's
// record (the lookup tool, the retired note) may back that.
export const MEMORY_CLAIM = /\b(offer|promotion|promo|code|coupon|sale|deal|discount|event)s?\b[^.!?\n]{0,80}\b(has ended|ended|expired|is over|was over|no longer (valid|running|active|available|applies))\b|\b(ended|expired)\b[^.!?\n]{0,40}\b(offer|promotion|promo|code|coupon|sale|deal|discount)s?\b|\b(discontinued|retired|phased out|no longer (make|makes|carry|carries|sell|sells|offer|offers|stock|stocks))\b|\bnot (made|sold|carried|available) anymore\b/i;
export function claimsFromMemory(text) {
  return MEMORY_CLAIM.test(String(text || ""));
}
