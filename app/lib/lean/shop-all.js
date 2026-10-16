// Lean engine — the "View all" link under product cards. Built from the
// filters of the search Claude ran to find the products it showed, so it opens
// the store's own search for the same thing ("View all Women's Pink Sandals").
// Pure.

const DEFAULT_PATTERN = "/search?q={q}&type=product";

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();
}

function genderLabel(g) {
  const v = String(g || "").toLowerCase();
  if (/^(women|womens|women's|female)$/.test(v)) return { token: "women", label: "Women's" };
  if (/^(men|mens|men's|male)$/.test(v)) return { token: "men", label: "Men's" };
  if (/^(kid|kids|kids'|children|youth|boys|girls)$/.test(v)) return { token: "kids", label: "Kids'" };
  return null;
}

// search: the search_products input. Returns { url, label } or null when the
// search was too vague to be worth a link (no line, category or color).
export function buildShopAllLink(search, { pattern = "" } = {}) {
  if (!search || typeof search !== "object") return null;
  const one = (list) => (Array.isArray(list) && list.length === 1 ? String(list[0]) : "");
  const gender = genderLabel(search.gender);
  const color = one(search.colors);
  const category = one(search.categories);
  if (!gender && !color && !category) return null;

  const tokens = [];
  const words = [];
  if (search.on_sale) { tokens.push("sale"); words.push("Sale"); }
  if (gender) { tokens.push(gender.token); words.push(gender.label); }
  if (color) { tokens.push(color.toLowerCase()); words.push(titleCase(color)); }
  if (category) { tokens.push(category.toLowerCase()); words.push(titleCase(category)); }
  else words.push("Styles");

  const q = tokens.map((t) => encodeURIComponent(t).replace(/%20/g, "+")).join("+");
  const tpl = String(pattern || "").includes("{q}") ? String(pattern).trim() : DEFAULT_PATTERN;
  return { url: tpl.replace("{q}", q), label: `View all ${words.join(" ")}` };
}
