// The store's promotions page (Settings → Promotions page): a page the team
// keeps up to date with what's running, read live so the assistant knows the
// current offers. Only the part above the store's chosen line is used (on
// Aetrex's terms page: everything above "STANDARD TERMS AND CONDITIONS OF
// SALE"). Pure helpers; the fetching is in promo-page.server.js.

export const PROMO_TEXT_MAX = 6000;

// The page's handle from its link: https://store.com/pages/terms-conditions
// → "terms-conditions" (also a bare "terms-conditions" or "/pages/x?y").
export function pageHandleFromUrl(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  const m = v.match(/\/pages\/([^/?#\s]+)/i) || v.match(/^([a-z0-9][a-z0-9-]*)$/i);
  if (!m) return "";
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return ""; }
}

const squash = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

// The text above the stop line (matched ignoring case and spacing). No stop
// line set, or the line isn't on the page: nothing — the whole page is legal
// terms, not offers, and guessing where the offers end could pass off old or
// legal text as a running promotion.
export function cutPromoSection(text, stopLine) {
  const body = String(text || "");
  const stop = squash(stopLine);
  if (!body.trim() || !stop) return "";
  const out = [];
  for (const line of body.split(/\n/)) {
    const flat = line.replace(/\s+/g, " ");
    const at = flat.toLowerCase().indexOf(stop);
    if (at >= 0) {
      // Keep what comes before the line on the same row (pages without breaks).
      out.push(flat.slice(0, at));
      return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, PROMO_TEXT_MAX);
    }
    out.push(line);
  }
  // The line broken over two rows: look in the page as one run of text.
  const flat = body.replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf(stop);
  return at > 0 ? flat.slice(0, at).trim().slice(0, PROMO_TEXT_MAX) : "";
}

// Today's date and time where the store's offers are written (they end at
// "11:59 PM PT" or "EST"), so the assistant can tell which have ended.
export function nowForPromos(now = new Date()) {
  const fmt = (tz) => now.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  return `${fmt("America/New_York")} Eastern (${fmt("America/Los_Angeles")} Pacific)`;
}

// The block the assistant reads with each chat.
export function promoPageBlock({ text, url = "", now = new Date() } = {}) {
  const body = String(text || "").trim();
  if (!body) return "";
  return [
    `PROMOTIONS FROM THE STORE'S PROMOTIONS PAGE${url ? ` (${url})` : ""}`,
    `Right now it's ${nowForPromos(now)}.`,
    "This is the store's own list of offers, kept up to date by the team. An offer here is running unless its own text says it has ended or its end date and time have passed — check every date against right now. Don't present an ended offer as running.",
    "Quote an offer's terms as written (who qualifies, limits, exclusions, how to get it). Don't add codes, amounts, products or conditions it doesn't state. If two lines disagree (one says an offer ended, another describes it as running), don't say it's running: say the details are shown at checkout, and link this page.",
    "---",
    body,
    "---",
  ].join("\n");
}
