// Lean engine — the "View all" button under product cards. When the search
// behind the cards matched more products than the reply shows, the button
// opens every match in a sheet inside the chat, a page at a time. The list
// is the chat's own search, so it's exactly what the assistant found —
// filters, size and color included. The first page comes with the reply; the
// sheet asks /apps/hajirai/view-all for the others, sending the search back.
// The words come from that search's filters ("View all 16 women's sale
// boots"). Pure.

export const VIEW_ALL_PAGE = 24;

const STRING_LISTS = ["categories", "colors", "activities", "conditions"];
const SORTS = new Set(["best", "price_low", "price_high"]);
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// The search, as the sheet sends it back: only what search_products takes,
// each value bounded. Returns null when nothing usable is left.
export function cleanViewAllSearch(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  const query = str(raw.query, 200);
  if (query) out.query = query;
  for (const key of STRING_LISTS) {
    const list = (Array.isArray(raw[key]) ? raw[key] : typeof raw[key] === "string" ? [raw[key]] : [])
      .map((v) => str(v, 60)).filter(Boolean).slice(0, 10);
    if (list.length) out[key] = list;
  }
  const gender = str(raw.gender, 30);
  if (gender) out.gender = gender;
  if (raw.on_sale === true) out.on_sale = true;
  const maxPrice = Number(raw.max_price);
  if (Number.isFinite(maxPrice) && maxPrice > 0) out.max_price = Math.min(maxPrice, 100000);
  const size = str(String(raw.size ?? ""), 12);
  if (size) out.size = size;
  const width = str(String(raw.width ?? ""), 20);
  if (width) out.width = width;
  const collection = str(String(raw.collection ?? ""), 255);
  if (collection) out.collection = collection;
  if (raw.colorful === true) out.colorful = true;
  if (SORTS.has(raw.sort)) out.sort = raw.sort;
  return Object.keys(out).length ? out : null;
}

// One page of a list: page numbers start at 1 and are kept in range.
export function pageOf(list, page, size = VIEW_ALL_PAGE) {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const n = Math.min(Math.max(Number.parseInt(page, 10) || 1, 1), pages);
  return { page: n, pages, total, pageSize: size, items: list.slice((n - 1) * size, n * size) };
}

function genderWord(g) {
  const v = String(g || "").toLowerCase();
  if (/^(women|womens|women's|female)$/.test(v)) return "women's";
  if (/^(men|mens|men's|male)$/.test(v)) return "men's";
  if (/^(kid|kids|kids'|children|youth|boys|girls)$/.test(v)) return "kids'";
  return "";
}

const clean = (s) => String(s || "").toLowerCase().replace(/\s*\/\s*/g, " & ").replace(/\s+/g, " ").trim();
const cap = (s) => s.replace(/(^|\s|&\s)([a-z])/g, (m, pre, c) => pre + c.toUpperCase());

// search: the search_products input; total: how many products it matched;
// collectionTitle: the seasonal collection's name, when the search is in it.
// Returns { label, title } — the button's words and the sheet's heading.
export function viewAllWords(search, total, { collectionTitle = "" } = {}) {
  const s = search && typeof search === "object" ? search : {};
  const size0 = String(s.size || "").trim().slice(0, 12);
  if (collectionTitle) {
    const name = String(collectionTitle).trim().slice(0, 40);
    return { label: `View all ${total} in ${name}`, title: `${name}${size0 ? ` · Size ${size0}` : ""}`.slice(0, 48) };
  }
  const one = (list) => (Array.isArray(list) && list.length === 1 ? clean(list[0]) : "");
  const width = clean(typeof s.width === "string" ? s.width : "").slice(0, 20);
  const words = [genderWord(s.gender), width, one(s.colors), s.on_sale ? "sale" : "", one(s.categories)].filter(Boolean);
  const noun = one(s.categories) ? "" : (words.length ? "styles" : "matches");
  const phrase = [...words, noun].filter(Boolean).join(" ");
  const size = String(s.size || "").trim().slice(0, 12);
  const heading = phrase === "matches" ? "All matches" : cap(phrase);
  return {
    label: `View all ${total} ${phrase}`,
    title: `${heading}${size ? ` · Size ${size}` : ""}`.slice(0, 48),
  };
}
