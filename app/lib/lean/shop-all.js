// Lean engine — the "View all" button under product cards. When the search
// behind the cards matched more products than the reply shows, the button
// opens every match in a sheet inside the chat. The list is the chat's own
// search, so it's exactly what the assistant found — filters, size and color
// included. The words come from that search's filters
// ("View all 16 women's sale boots"). Pure.

export const VIEW_ALL_MAX = 48;

function genderWord(g) {
  const v = String(g || "").toLowerCase();
  if (/^(women|womens|women's|female)$/.test(v)) return "women's";
  if (/^(men|mens|men's|male)$/.test(v)) return "men's";
  if (/^(kid|kids|kids'|children|youth|boys|girls)$/.test(v)) return "kids'";
  return "";
}

const clean = (s) => String(s || "").toLowerCase().replace(/\s*\/\s*/g, " & ").replace(/\s+/g, " ").trim();
const cap = (s) => s.replace(/(^|\s|&\s)([a-z])/g, (m, pre, c) => pre + c.toUpperCase());

// search: the search_products input; total: how many products it matched.
// Returns { label, title } — the button's words and the sheet's heading.
export function viewAllWords(search, total) {
  const s = search && typeof search === "object" ? search : {};
  const one = (list) => (Array.isArray(list) && list.length === 1 ? clean(list[0]) : "");
  const words = [genderWord(s.gender), one(s.colors), s.on_sale ? "sale" : "", one(s.categories)].filter(Boolean);
  const noun = one(s.categories) ? "" : (words.length ? "styles" : "matches");
  const phrase = [...words, noun].filter(Boolean).join(" ");
  const size = String(s.size || "").trim().slice(0, 12);
  const heading = phrase === "matches" ? "All matches" : cap(phrase);
  return {
    label: `View all ${total} ${phrase}`,
    title: `${heading}${size ? ` · Size ${size}` : ""}`.slice(0, 48),
  };
}
