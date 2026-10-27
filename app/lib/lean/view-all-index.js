// The "View all" sheet's filters: a small index of every product a search
// matched — the sizes and widths in stock (paired, per variant, so "8 wide"
// means one pair that's both), colors, type, line, foot needs, price, sale
// and rating — in the search's own order. The sheet filters, counts and
// sorts with it in the browser, instantly; the cards themselves are fetched
// by handle as they're shown. Pure.
import { ratingOf } from "./merch.js";

// Color groups as shoppers browse them. A colorway can be in more than one
// ("Black/White", "Navy Coral"); one no group knows is "Other".
const COLOR_GROUPS = [
  ["black", "Black", ["black", "noir", "onyx", "jet"]],
  ["white", "White", ["white", "ivory", "cream", "off white", "bone", "snow"]],
  ["grey", "Grey", ["grey", "gray", "charcoal", "slate", "graphite", "pewter", "smoke", "heather", "ash"]],
  ["navy", "Navy", ["navy", "midnight", "indigo"]],
  ["blue", "Blue", ["blue", "denim", "cobalt", "sky", "royal", "turquoise", "aqua", "teal", "periwinkle", "ocean", "chambray"]],
  ["red", "Red", ["red", "burgundy", "wine", "maroon", "crimson", "cherry", "ruby", "scarlet", "berry", "raspberry", "merlot", "oxblood"]],
  ["pink", "Pink", ["pink", "rose", "blush", "mauve", "fuchsia", "magenta", "coral", "salmon", "peach"]],
  ["purple", "Purple", ["purple", "plum", "eggplant", "lavender", "violet", "lilac", "orchid", "grape"]],
  ["green", "Green", ["green", "olive", "sage", "mint", "emerald", "lime", "jade", "forest", "army", "moss", "hunter"]],
  ["yellow", "Yellow", ["yellow", "mustard", "honey", "lemon", "sunflower", "marigold"]],
  ["orange", "Orange", ["orange", "terracotta", "rust", "tangerine", "papaya", "burnt"]],
  ["brown", "Brown", ["brown", "chocolate", "cognac", "espresso", "mocha", "chestnut", "walnut", "coffee", "cocoa", "chai", "whiskey", "saddle", "tobacco"]],
  ["tan", "Tan & beige", ["tan", "beige", "nude", "sand", "khaki", "camel", "stone", "taupe", "oatmeal", "natural", "latte", "biscuit", "wheat"]],
  ["metallic", "Metallic", ["gold", "silver", "bronze", "copper", "metallic", "champagne", "rose gold", "platinum"]],
  ["multi", "Multi & print", ["multi", "multicolor", "print", "floral", "leopard", "animal", "camo", "pattern", "snake", "plaid", "rainbow", "cheetah"]],
];
const OTHER = ["other", "Other"];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GROUP_RE = COLOR_GROUPS.map(([key, , words]) => [key, new RegExp(`(^|[^a-z])(${words.map(esc).join("|")})([^a-z]|$)`)]);

export function colorGroupsOf(colors = []) {
  const text = colors.map((c) => String(c || "").toLowerCase().replace(/[_-]+/g, " ")).join(" / ");
  if (!text.trim()) return [];
  const keys = GROUP_RE.filter(([, re]) => re.test(text)).map(([key]) => key);
  return keys.length ? keys : [OTHER[0]];
}

const LINE_LABEL = { women: "Women's", men: "Men's", kids: "Kids'" };
const lineKey = (g) => {
  const v = String(g || "").toLowerCase();
  if (/^(women|womens|women's|female|ladies)$/.test(v)) return "women";
  if (/^(men|mens|men's|male)$/.test(v)) return "men";
  if (/^(kid|kids|kids'|children|youth|boys|girls)$/.test(v)) return "kids";
  if (/^unisex$/.test(v)) return "unisex";
  return "";
};

// Narrowest first, the way size charts read.
const WIDTH_RANK = [
  [/^(n|narrow|slim|aa|a)$/i, 0],
  [/^(m|medium|regular|standard|b|average)$/i, 1],
  [/^(w|wide|d|c|e)$/i, 2],
  [/^(xw|ww|x-?wide|extra[ -]?wide|2e|ee|3e|4e|eee)$/i, 3],
];
const widthRank = (w) => (WIDTH_RANK.find(([re]) => re.test(String(w).trim())) || [null, 9])[1];
const firstNumber = (s) => { const m = String(s).match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : NaN; };
const optionOf = (bag, re) => { for (const [k, v] of Object.entries(bag || {})) if (re.test(k)) return String(v ?? "").trim(); return ""; };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// A facet's values, each with a key (what's matched) and a label (what's
// shown), in the order they're listed.
function facet() {
  const byKey = new Map();
  return {
    add(key, label) {
      if (!key) return -1;
      if (!byKey.has(key)) byKey.set(key, { key, label, n: 0, i: byKey.size });
      const v = byKey.get(key);
      v.n += 1;
      return v.i;
    },
    values: () => [...byKey.values()],
  };
}

// products: the matched products, best first (search.js allMatches).
export function buildViewAllIndex(products = [], { max = 1500 } = {}) {
  const list = products.slice(0, max);
  const sizes = facet(), widths = facet(), colors = facet(), types = facet(), lines = facet(), needs = facet();
  let minPrice = Infinity, maxPrice = 0, sale = 0, rated = 0;
  const raw = list.map((p) => {
    const item = { h: p.handle };
    // Sizes and widths in stock, paired per variant.
    const pairs = new Set();
    for (const bag of p.stock || []) {
      const size = optionOf(bag, /size/i);
      const width = optionOf(bag, /width/i);
      if (!size && !width) continue;
      const si = size ? sizes.add(size.toLowerCase().replace(/\s+/g, " "), size) : -1;
      const wi = width ? widths.add(width.toLowerCase(), width) : -1;
      pairs.add(`${si},${wi}`);
    }
    if (pairs.size) item.sw = [...pairs].map((s) => s.split(",").map(Number));
    const cs = colorGroupsOf(p.colors?.length ? p.colors : [colorwayName(p)]);
    if (cs.length) item.c = cs.map((k) => colors.add(k, (COLOR_GROUPS.find(([g]) => g === k) || OTHER)[1]));
    const type = String(p.category || "").trim();
    if (type) item.t = types.add(type.toLowerCase(), type);
    const ls = [...new Set((p.gender || []).map(lineKey).filter(Boolean))];
    // Unisex counts as each line, as the assistant's search treats it.
    const shown = ls.includes("unisex") ? [...new Set([...ls.filter((l) => l !== "unisex"), "women", "men"])] : ls;
    if (shown.length) item.l = shown.map((k) => lines.add(k, LINE_LABEL[k] || cap(k)));
    if (p.conditions?.length) item.n = p.conditions.map((c) => needs.add(c.toLowerCase(), cap(c)));
    if (Number.isFinite(p.price)) {
      item.p = Math.round(p.price * 100);
      minPrice = Math.min(minPrice, p.price);
      maxPrice = Math.max(maxPrice, p.price);
    }
    if (p.onSale) { item.s = 1; sale += 1; }
    const { rating, count } = ratingOf(p);
    if (Number.isFinite(rating)) { item.r = Math.round(rating * 10); item.rc = Number.isFinite(count) ? count : 0; rated += 1; }
    return item;
  });

  // Sizes in size order and widths narrowest first: renumber, then remap.
  const sizeVals = sizes.values();
  const unit = sizeVals.length && sizeVals.every((v) => /\s*us$/i.test(v.label)) ? "US" : "";
  const sizeOrder = [...sizeVals].sort((a, b) => {
    const na = firstNumber(a.label), nb = firstNumber(b.label);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    if (Number.isFinite(na) !== Number.isFinite(nb)) return Number.isFinite(na) ? -1 : 1;
    return a.i - b.i;
  });
  const widthOrder = [...widths.values()].sort((a, b) => widthRank(a.label) - widthRank(b.label) || b.n - a.n);
  const remap = (order) => new Map(order.map((v, i) => [v.i, i]));
  const sMap = remap(sizeOrder), wMap = remap(widthOrder);
  for (const item of raw) {
    if (item.sw) item.sw = item.sw.map(([s, w]) => [s < 0 ? -1 : sMap.get(s), w < 0 ? -1 : wMap.get(w)]);
  }
  // Colors, types, lines and needs: most common first (the index keeps its numbers).
  const byCount = (vals) => vals.slice().sort((a, b) => b.n - a.n || a.i - b.i).map((v) => v.i);
  const pack = (vals, order) => ({ values: vals.map((v) => ({ k: v.key, l: v.label, n: v.n })), order });

  return {
    total: raw.length,
    facets: {
      size: {
        unit,
        values: sizeOrder.map((v) => ({ k: v.key, l: unit ? v.label.replace(/\s*us$/i, "") : v.label, n: v.n })),
      },
      width: { values: widthOrder.map((v) => ({ k: v.key, l: v.label, n: v.n })) },
      color: pack(colors.values(), byCount(colors.values())),
      type: pack(types.values(), byCount(types.values())),
      line: pack(lines.values(), byCount(lines.values())),
      needs: pack(needs.values(), byCount(needs.values())),
      price: Number.isFinite(minPrice) ? { min: Math.floor(minPrice), max: Math.ceil(maxPrice) } : null,
      sale,
      rated,
    },
    items: raw,
  };
}

// The colorway's name from its title, when the store keeps no color field
// ("Danika Sneaker - Light Blue" → "Light Blue").
function colorwayName(p) {
  const rest = String(p.title || "").slice(String(p.style || "").length).replace(/^\s*[-–—]\s*/, "").trim();
  return rest;
}
