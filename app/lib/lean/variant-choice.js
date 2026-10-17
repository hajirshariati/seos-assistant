// Lean engine — turns what the customer said ("size 8, wide") into the exact
// option values of a product ("8 US", "Wide"), so its card can offer a
// one-tap Add to cart. Only unambiguous matches are kept; anything unclear is
// left for the customer to pick in the chat. Pure.

const WIDTH_WORDS = {
  n: "narrow", narrow: "narrow", slim: "narrow",
  m: "medium", med: "medium", medium: "medium", regular: "medium", standard: "medium", normal: "medium",
  w: "wide", wide: "wide",
  xw: "extra wide", "x-wide": "extra wide", "extra wide": "extra wide", "extra-wide": "extra wide", ww: "extra wide",
};

const norm = (v) => {
  const s = String(v ?? "").toLowerCase().replace(/\b(us|uk|eu)\b/g, " ").replace(/\s+/g, " ").trim();
  return WIDTH_WORDS[s] || s;
};

function matchValue(values, wanted) {
  const w = norm(wanted);
  if (!w) return null;
  const exact = values.filter((v) => norm(v) === w);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  // A size range like "8.5 - 9" holds the size asked for.
  const n = Number(w);
  if (Number.isFinite(n)) {
    const ranged = values.filter((v) => {
      const parts = norm(v).split(/\s*-\s*/).map(Number);
      return parts.length === 2 && parts.every(Number.isFinite) && n >= parts[0] && n <= parts[1];
    });
    if (ranged.length === 1) return ranged[0];
  }
  return null;
}

// product.options: { Size: ["7 US", "8 US"], Width: ["Medium", "Wide"] }
// wanted: { size: "8", width: "wide" } (keys in any case)
export function resolvePreselect(product, wanted) {
  if (!product?.options || !wanted || typeof wanted !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(wanted)) {
    const name = Object.keys(product.options).find((n) => n.toLowerCase() === String(key).toLowerCase().trim());
    if (!name) continue;
    const exact = matchValue(product.options[name], value);
    if (exact) out[name] = exact;
  }
  return Object.keys(out).length ? out : null;
}
