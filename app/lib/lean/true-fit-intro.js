// "Find my shoe size" before the shopper has picked a shoe. True Fit sizes
// one shoe at a time — every style fits a little differently — so the reply
// says so and offers the store's own kinds of shoes to start from: each one
// in stock, per line (women's / men's), with how many styles it has and a
// photo of the one that sells best. Tapping one asks the assistant for those
// shoes; every shoe card has its own True Fit button. Pure.
import { productKind } from "./catalog.js";
import { merchScore } from "./merch.js";
import { LINE_LABEL, lineKey } from "./view-all-index.js";

export const TRUE_FIT_INTRO_TEXT =
  "Let's find your perfect size! True Fit sizes one shoe at a time, so pick the shoe first — then you'll get your size for that exact style.";

// For the reply to a style tile: what the shopper is choosing a shoe for.
export const TRUE_FIT_PICK_NOTE =
  "The customer tapped this kind of shoe to get their size with True Fit: show the best 3-4 of them and, in a few words, tell them to tap the True Fit button on the shoe they like to get their size for it. Don't guess a size.";

const MAX_TILES = 6;
const LINE_ORDER = ["women", "men", "kids"];

// Shopify's CDN serves any width: tiles are small, so ask for a small one.
function tileImage(url) {
  const u = String(url || "");
  if (!/^https:\/\//.test(u)) return "";
  if (!/cdn\.shopify\.com|\/cdn\/shop\//.test(u) || /[?&]width=/.test(u)) return u;
  return `${u}${u.includes("?") ? "&" : "?"}width=320`;
}

// The lines a shoe is sold in. Unisex is both; no line given is every line.
function linesOf(p) {
  const ks = [...new Set((p.gender || []).map(lineKey).filter(Boolean))];
  return ks.includes("unisex") ? [...new Set([...ks.filter((k) => k !== "unisex"), "women", "men"])] : ks;
}

// → the size_intro event, or null when the store has fewer than two kinds of
// shoe in stock (then the assistant answers as usual).
export function trueFitIntro(catalog, { primaryLine = "" } = {}) {
  const shoes = (catalog?.products || []).filter((p) => p.inStock && productKind(p) === "footwear" && String(p.category || "").trim());
  if (!shoes.length) return null;
  const known = new Set(shoes.flatMap(linesOf));
  const lineKeys = LINE_ORDER.filter((k) => known.has(k));
  const keys = lineKeys.length ? lineKeys : ["all"];
  // line → category → { label, styles, best }
  const byLine = new Map(keys.map((k) => [k, new Map()]));
  for (const p of shoes) {
    const mine = linesOf(p).filter((k) => byLine.has(k));
    const label = String(p.category).trim();
    const cat = label.toLowerCase();
    const score = merchScore(p);
    for (const k of mine.length ? mine : keys) {
      const cats = byLine.get(k);
      if (!cats.has(cat)) cats.set(cat, { label, styles: new Set(), best: null, score: -1 });
      const c = cats.get(cat);
      c.styles.add(String(p.style || p.title).toLowerCase());
      if (p.image && score > c.score) { c.best = p; c.score = score; }
    }
  }
  const lines = keys
    .map((k) => ({
      k,
      l: LINE_LABEL[k] || "",
      tiles: [...byLine.get(k).entries()]
        .map(([key, c]) => ({ k: key, l: c.label, n: c.styles.size, img: tileImage(c.best?.image) }))
        .sort((a, b) => b.n - a.n || a.l.localeCompare(b.l))
        .slice(0, MAX_TILES),
    }))
    .filter((line) => line.tiles.length >= 2);
  if (!lines.length) return null;
  const most = lines.slice().sort((a, b) => b.tiles.reduce((n, t) => n + t.n, 0) - a.tiles.reduce((n, t) => n + t.n, 0))[0];
  const line = lines.some((x) => x.k === primaryLine) ? primaryLine : most.k;
  return { type: "size_intro", provider: "truefit", line, lines };
}
