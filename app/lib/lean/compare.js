// Lean engine — product comparison. Pure.
//
// Every value in a comparison comes from the store's catalog, exactly as
// synced: price, rating, what each product is, what it helps with, its
// comfort features, materials, measurements, stock. Nothing is written or
// guessed by the model — Claude only picks which products to compare and may
// sum up the difference in a sentence (checked against these same facts).
//
// Rows a product has no data for show as missing, never as a made-up value;
// a row no product has data for isn't shown. Each row says whether the
// products differ on it, so the widget can lead with the differences.

import { titleSuffixColor } from "../color-match.js";

export const COMPARE_MAX = 3;

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "for", "in", "of", "on", "or", "the", "to", "with"]);

// "plantar fasciitis" → "Plantar Fasciitis"; text that already has capitals
// is the store's own wording and is kept as written.
export function displayCase(s) {
  const t = String(s || "").trim();
  if (!t || /[A-Z]/.test(t)) return t;
  return t.split(/(\s+|-)/).map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("");
}

// A sentence of a list item: first letter up, the rest as written.
function sentenceCase(s) {
  const t = String(s || "").trim().replace(/[.;,\s]+$/, "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

const norm = (s) => String(s || "").toLowerCase().replace(/[™®]/g, "").replace(/[^a-z0-9.]+/g, " ").trim();

// Store text fields arrive as "point one; point two" (HTML lists flattened).
function bullets(text) {
  return String(text || "")
    .split(/\s*;\s*|\s*\n\s*|\s+•\s+/)
    .map(sentenceCase)
    .filter((x) => x && x.length <= 200);
}

function attr(p, keys) {
  const a = p.attributes || {};
  for (const k of keys) if (a[k] != null && String(a[k]).trim()) return String(a[k]).trim();
  return "";
}

// Review score from any of the shapes stores keep it in: "4.4", or Shopify's
// rating metafield {"value":"4.4","scale_max":"5.0"}.
function rating(p) {
  let raw = attr(p, ["rating", "reviews_average", "review_rating", "average_rating", "rating_average"]);
  let scale = 5;
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw);
      raw = String(j.value ?? "");
      scale = parseFloat(j.scale_max) || 5;
    } catch { raw = ""; }
  }
  const avg = parseFloat(raw);
  const count = parseInt(attr(p, ["review_count", "reviews_count", "rating_count"]).replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(avg) || avg <= 0 || avg > scale) return null;
  // A score with no reviews behind it isn't a rating.
  if (Number.isFinite(count) && count === 0) return null;
  return { avg: Math.round((avg / scale) * 5 * 10) / 10, count: Number.isFinite(count) ? count : null };
}

// "Heel Height: 1.125\"; Shaft Height: 4\"" → [["Heel Height", "1.125\""], …]
function measurements(p) {
  const out = [];
  for (const b of bullets(attr(p, ["measurements", "measurements_details", "dimensions"]))) {
    const m = b.match(/^([^:]{2,40}):\s*(.{1,60})$/);
    if (m) out.push([displayCase(m[1].trim()), m[2].trim()]);
  }
  return out;
}

const sizeNum = (s) => parseFloat(String(s).match(/\d+(?:\.\d+)?/)?.[0] ?? "NaN");

// In-stock sizes as a short range ("5–12") when they're numbers.
function sizeRange(sizes) {
  if (!sizes.length) return "";
  const nums = sizes.map(sizeNum);
  if (nums.some((n) => !Number.isFinite(n))) return sizes.slice(0, 12).map((s) => s.toUpperCase()).join(", ");
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

const money = (n) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : "");

// One product's facts, ready for the table.
function facts(p, catalog) {
  const siblings = (catalog.products || []).filter((x) => x.style.toLowerCase() === p.style.toLowerCase() && x.inStock);
  const colorways = [...new Set(siblings.flatMap((x) => x.colors.slice(0, 1)).map(displayCase))];
  return {
    handle: p.handle,
    title: p.title,
    name: p.style || p.title,
    color: displayCase(titleSuffixColor(p.title) || p.colors[0] || ""),
    url: p.url,
    image: p.image,
    price: Number.isFinite(p.price) ? p.price : null,
    priceLabel: p.priceLabel,
    compareAtLabel: p.onSale ? money(p.compareAtPrice) : "",
    onSale: Boolean(p.onSale),
    inStock: Boolean(p.inStock),
    rating: rating(p),
    // Options the shopper still has to pick (Size, Width…), so the table's
    // button reads "Select size" like the product cards do.
    choose: Object.entries(p.options || {}).filter(([, vals]) => Array.isArray(vals) && vals.length > 1).map(([name]) => name),
    kind: displayCase(p.subcategory || p.category || p.productType),
    gender: p.gender.map(displayCase).join(", "),
    activities: p.activities.map(displayCase),
    conditions: p.conditions.map(displayCase),
    comfort: bullets(attr(p, ["comfort", "comfort_details", "comfort_features", "features"])),
    materials: bullets(attr(p, ["materials", "materials_details", "material"])),
    measurements: measurements(p),
    widths: p.widths.map((w) => w.toUpperCase().length <= 3 ? w.toUpperCase() : displayCase(w)),
    sizes: sizeRange(p.sizes),
    colorways,
    // Store text arrives lower-cased from the sync ("aetrex.com exclusive").
    badge: displayCase(p.badge),
  };
}

// A row of single values: differs when the products' values aren't all the same.
function textRow(key, label, values) {
  if (values.every((v) => !v)) return null;
  const seen = new Set(values.map((v) => norm(v)));
  return { key, label, type: "text", values: values.map((v) => v || null), differ: seen.size > 1 };
}

// A row of lists: what all of them share, and what each has that not all do.
function listRow(key, label, lists) {
  if (lists.every((l) => !l.length)) return null;
  const sets = lists.map((l) => new Set(l.map(norm)));
  const shared = lists[0].filter((x) => sets.every((s) => s.has(norm(x))));
  const sharedSet = new Set(shared.map(norm));
  const unique = lists.map((l) => l.filter((x) => !sharedSet.has(norm(x))));
  return { key, label, type: "list", values: lists, shared, unique, differ: unique.some((u) => u.length) };
}

export function buildComparison(catalog, handles = []) {
  const byHandle = new Map((catalog?.products || []).map((p) => [p.handle, p]));
  const wanted = [...new Set((Array.isArray(handles) ? handles : []).map((h) => String(h || "").trim()).filter(Boolean))];
  const missing = wanted.filter((h) => !byHandle.has(h));
  const picked = wanted.filter((h) => byHandle.has(h)).slice(0, COMPARE_MAX).map((h) => byHandle.get(h));
  if (picked.length < 2) {
    return { error: picked.length ? "Pick at least two different products to compare." : "Those products weren't found. Search first.", missing };
  }
  return {
    ...compareProducts(picked, catalog),
    // Phones show two columns at a time: the first product against each of
    // the others, each pair compared on its own (which is lower priced,
    // what both share) rather than cut from the three-way table.
    ...(picked.length > 2 ? { pairs: picked.slice(1).map((p) => compareProducts([picked[0], p], catalog)) } : {}),
    ...(missing.length ? { missing } : {}),
    ...(wanted.length > COMPARE_MAX ? { note: `Only ${COMPARE_MAX} products can be compared at once; the first ${COMPARE_MAX} are shown.` } : {}),
  };
}

function compareProducts(picked, catalog) {
  const f = picked.map((p) => facts(p, catalog));
  const rows = [];
  const add = (r) => { if (r) rows.push(r); };

  // Price: the lower one is marked when they differ.
  const prices = f.map((x) => x.price);
  const priceDiffer = new Set(f.map((x) => x.priceLabel)).size > 1 || f.some((x) => x.onSale) !== f.every((x) => x.onSale);
  const allPriced = prices.every((x) => x != null);
  const low = allPriced ? Math.min(...prices) : null;
  rows.push({
    key: "price", label: "Price", type: "price",
    values: f.map((x) => (x.priceLabel ? { label: x.priceLabel, compareAt: x.compareAtLabel || null, onSale: x.onSale } : null)),
    differ: priceDiffer,
    best: allPriced && priceDiffer && prices.filter((x) => x === low).length === 1 ? prices.indexOf(low) : null,
    bestLabel: "Lower price",
  });

  // Rating: the higher one is marked only when both are rated, by at least a
  // tenth of a star, with reviews behind them.
  const ratings = f.map((x) => x.rating);
  if (ratings.some(Boolean)) {
    const rated = ratings.every((r) => r && (r.count == null || r.count >= 5));
    const top = rated ? Math.max(...ratings.map((r) => r.avg)) : null;
    const ratingDiffer = new Set(ratings.map((r) => (r ? `${r.avg}|${r.count}` : "none"))).size > 1;
    rows.push({
      key: "rating", label: "Rating", type: "rating", values: ratings, differ: ratingDiffer,
      best: rated && ratings.filter((r) => r.avg === top).length === 1 && ratings.some((r) => top - r.avg >= 0.1) ? ratings.findIndex((r) => r.avg === top) : null,
      bestLabel: "Higher rated",
    });
  }

  add(textRow("kind", "Type", f.map((x) => x.kind)));
  add(textRow("gender", "For", f.map((x) => x.gender)));
  add(listRow("helps_with", "Helps with", f.map((x) => x.conditions)));
  add(listRow("best_for", "Made for", f.map((x) => x.activities)));
  add(listRow("comfort", "Comfort features", f.map((x) => x.comfort)));
  add(listRow("materials", "Materials", f.map((x) => x.materials)));
  // Measurements, one row each (heel height, shaft height…).
  const mLabels = [];
  for (const x of f) for (const [label] of x.measurements) if (!mLabels.some((l) => norm(l) === norm(label))) mLabels.push(label);
  for (const label of mLabels.slice(0, 4)) {
    add(textRow(`m_${norm(label).replace(/ /g, "_")}`, label, f.map((x) => (x.measurements.find(([l]) => norm(l) === norm(label)) || [])[1] || "")));
  }
  add(listRow("widths", "Widths in stock", f.map((x) => x.widths)));
  add(textRow("sizes", "Sizes in stock", f.map((x) => x.sizes)));
  add(listRow("colors", "Colors", f.map((x) => x.colorways)));
  add(textRow("badge", "Highlights", f.map((x) => x.badge)));

  const sameStyle = new Set(picked.map((p) => p.style.toLowerCase())).size === 1;
  return {
    products: f.map(({ handle, title, name, color, url, image, priceLabel, compareAtLabel, onSale, inStock, rating: r, choose }) => ({ handle, title, name, color, url, image, priceLabel, compareAtLabel, onSale, inStock, rating: r, choose })),
    rows,
    sameStyle,
    differences: rows.filter((r) => r.differ).length,
  };
}

// What the shopper sees above the table when they asked from the cards (no
// model involved): which products, and the headline differences.
export function comparisonIntro(cmp) {
  if (!cmp?.products?.length) return "";
  const names = cmp.products.map((p) => (cmp.sameStyle ? p.color || p.name : p.name));
  const list = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  if (cmp.sameStyle) return `Same style, different colors: the ${list} are built the same, so pick the color you love.`;
  const diff = cmp.rows.filter((r) => r.differ && r.key !== "colors" && r.key !== "sizes" && r.key !== "widths").map((r) => r.label.toLowerCase());
  if (!diff.length) return `Here's the ${list} side by side. They're very alike on what the store lists.`;
  const top = diff.slice(0, 3);
  const said = top.length === 1 ? top[0] : `${top.slice(0, -1).join(", ")} and ${top.at(-1)}`;
  return `Here's the ${list} side by side. They differ most in ${said}.`;
}

// The same facts as text, for the model (to sum up honestly) and the fact
// check. Differences first.
export function comparisonFacts(cmp) {
  if (!cmp?.products) return "";
  const names = cmp.products.map((p) => p.title);
  const val = (r, i) => {
    const v = r.values[i];
    if (v == null || (Array.isArray(v) && !v.length)) return "not listed";
    if (r.type === "price") return `${v.label}${v.compareAt ? ` (was ${v.compareAt})` : ""}`;
    if (r.type === "rating") return `${v.avg} stars${v.count != null ? ` from ${v.count} reviews` : ""}`;
    if (r.type === "list") return r.unique[i].length ? `only this one: ${r.unique[i].join(", ")}` : "nothing beyond the shared list";
    return String(v);
  };
  const lines = [];
  for (const r of [...cmp.rows.filter((x) => x.differ), ...cmp.rows.filter((x) => !x.differ)]) {
    if (r.type === "list") {
      const per = names.map((n, i) => `${n}: ${val(r, i)}`).join(" | ");
      lines.push(`${r.label}${r.differ ? " (differs)" : " (same)"} — shared: ${r.shared.join(", ") || "none"}${r.differ ? ` | ${per}` : ""}`);
    } else {
      lines.push(`${r.label}${r.differ ? " (differs)" : " (same)"} — ${names.map((n, i) => `${n}: ${val(r, i)}`).join(" | ")}`);
    }
  }
  return lines.join("\n").slice(0, 4000);
}
