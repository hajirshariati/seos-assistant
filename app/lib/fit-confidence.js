// Fit confidence — how sure a shopper can be that a style fits as expected,
// from what its buyers did and said:
//  - reviewers' own answers to "How did it fit?" / "How did the width fit?"
//    (the store's Yotpo review form: runs small · true to size · runs large),
//  - pairs sold and sent back in the last 12 months (Shopify's sales report),
//  - why they came back (AfterShip return reasons: too small, too large…).
// One score per style and line, across all its colors. It says how a style
// fits — never which size to buy (True Fit does that). Pure.

// Below both of these a style shows no score: too little to go on.
export const FIT_MIN_ANSWERS = 5; // reviews that answered a fit question
export const FIT_MIN_SOLD = 30; // pairs sold in the last 12 months

// How strongly a style's own numbers count against the store's average for
// its kind of product (pseudo-counts): a style with few reviews or sales
// stays near the average; a well-known one speaks for itself.
const PRIOR_ANSWERS = 10;
const PRIOR_SOLD = 50;
const PRIOR_REASONS = 10;
const PRIOR_SIZE_SOLD = 30;

// A size shows its own score once this many pairs of it were sold.
export const FIT_MIN_SIZE_SOLD = 20;

export const FIT_LABELS = {
  true: "True to size",
  small: "Runs small",
  large: "Runs large",
  narrow: "Runs narrow",
  wide: "Runs wide",
};

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// The style a product belongs to, with its line when the store says it's a
// men's or women's product: every color of "Chase Arch Support Sneaker"
// (men's) is one style. "" when there's no style name.
export function fitStyleKey(p) {
  const style = String(p?.style || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!style) return "";
  const g = (Array.isArray(p?.gender) ? p.gender : []).map((x) => String(x).toLowerCase());
  const women = g.some((x) => /\bwom[ae]n/.test(x));
  const men = g.some((x) => /\bmen\b|\bmen's|\bmens\b/.test(x));
  const line = women && !men ? "w" : men && !women ? "m" : "";
  return line ? `${style}|${line}` : style;
}

// ── Reviews ───────────────────────────────────────────────────────────────

// One answer to a fit question → "low" (runs small / narrow), "true" or
// "high" (runs large / wide); null when it isn't one. A Size-type question
// stores the option's place (1 · 2 · 3); a choice question its words. A
// number from any other kind of question (a 1–5 rating) is never read as fit.
function answerSide(value, type) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    if (type && type !== "size") return null;
    return raw === "1" ? "low" : raw === "2" ? "true" : raw === "3" ? "high" : null;
  }
  const s = raw.toLowerCase();
  if (/\btrue\b|\bperfect|as expected|just right/.test(s)) return "true";
  if (/small|short|narrow|tight/.test(s)) return "low";
  if (/large|big|long|wide|loose/.test(s)) return "high";
  return null;
}

// A review's fit answers: { size, width }, each "low" | "true" | "high" | null.
// Reads Yotpo's review form fields as the widget API sends them
// (custom_fields: { "--114564": { title: "Size", field_type: "Size", value: 2 } })
// and as Yotpo's newer storefront data does (customFields, fieldType).
export function reviewFit(review) {
  const out = { size: null, width: null };
  const fields = review?.custom_fields || review?.customFields;
  if (!fields || typeof fields !== "object") return out;
  for (const f of Object.values(fields)) {
    if (!f || typeof f !== "object") continue;
    const title = String(f.title || "").toLowerCase();
    const type = String(f.field_type || f.fieldType || "").toLowerCase();
    const kind = /width/.test(title) ? "width" : /\b(size|sizing|fit|length)\b/.test(title) ? "size" : null;
    if (!kind || out[kind]) continue;
    out[kind] = answerSide(f.value, type);
  }
  return out;
}

// Reviews (each once, by id) → how they answered. `fits`: reviews whose every
// fit answer was "true to size" / "true to width".
export function tallyReviewFit(reviews = []) {
  const seen = new Set();
  const t = { reviews: 0, answered: 0, fits: 0, size: { low: 0, true: 0, high: 0 }, width: { low: 0, true: 0, high: 0 } };
  for (const r of reviews) {
    if (!r || typeof r !== "object") continue;
    const id = r.id != null ? String(r.id) : "";
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    t.reviews++;
    const a = reviewFit(r);
    if (!a.size && !a.width) continue;
    t.answered++;
    if (a.size) t.size[a.size]++;
    if (a.width) t.width[a.width]++;
    if ((!a.size || a.size === "true") && (!a.width || a.width === "true")) t.fits++;
  }
  return t;
}

// ── Returns ───────────────────────────────────────────────────────────────

const reasonText = (v) => (v && typeof v === "object" ? String(v.name || v.title || v.reason || "") : String(v || ""));

// An AfterShip return reason (and sub-reason) → "small" | "large" | "narrow" |
// "wide" | "fit" (another size or fit reason) | "other".
export function returnReasonKind(reason, subreason = "") {
  const s = `${reasonText(reason)} ${reasonText(subreason)}`.toLowerCase();
  if (/narrow/.test(s)) return "narrow";
  if (/\bwide\b|\bwider\b/.test(s)) return "wide";
  if (/size up|bigger size|larger size|half size up|size larger/.test(s)) return "small";
  if (/size down|smaller size|half size down|size smaller/.test(s)) return "large";
  if (/small|short|tight/.test(s)) return "small";
  if (/large|\bbig\b|\blong\b|loose/.test(s)) return "large";
  if (/\bsize|\bsizing|\bfit/.test(s)) return "fit";
  return "other";
}
export const FIT_RETURN_KINDS = ["small", "large", "narrow", "wide", "fit"];

// ── Scores ────────────────────────────────────────────────────────────────

// A style's numbers, empty.
export function emptyFitStats() {
  return {
    kind: "",
    answered: 0, fits: 0,
    size: { low: 0, true: 0, high: 0 },
    width: { low: 0, true: 0, high: 0 },
    sold: 0, returned: 0,
    // AfterShip return items by reason kind (+ every item read).
    reasons: { small: 0, large: 0, narrow: 0, wide: 0, fit: 0, other: 0 },
    // Pairs sold / returned per size ("9", "9.5"…), for a shopper's own size.
    sizes: {},
  };
}

const reasonTotal = (r) => FIT_RETURN_KINDS.reduce((n, k) => n + num(r?.[k]), 0) + num(r?.other);
const fitReasons = (r) => FIT_RETURN_KINDS.reduce((n, k) => n + num(r?.[k]), 0);

// The store's averages per kind of product (footwear, orthotic…), which a
// style with little data leans toward:
//  reviewFit     — share of reviewers who said it fit as expected (null: none)
//  fitShare      — share of AfterShip returns made for size or fit (null: no
//                  AfterShip data, and then every return counts as one)
//  fitReturnRate — pairs returned for fit per pair sold
export function fitBaselines(styles = []) {
  const by = new Map();
  for (const s of styles) {
    const k = s.kind || "";
    if (!by.has(k)) by.set(k, { answered: 0, fits: 0, sold: 0, returned: 0, reasonsAll: 0, reasonsFit: 0 });
    const b = by.get(k);
    b.answered += num(s.answered); b.fits += num(s.fits);
    b.sold += num(s.sold); b.returned += Math.min(num(s.returned), num(s.sold));
    b.reasonsAll += reasonTotal(s.reasons); b.reasonsFit += fitReasons(s.reasons);
  }
  const out = {};
  for (const [k, b] of by) {
    const fitShare = b.reasonsAll > 0 ? b.reasonsFit / b.reasonsAll : null;
    out[k] = {
      reviewFit: b.answered > 0 ? b.fits / b.answered : null,
      fitShare,
      fitReturnRate: b.sold > 0 ? (b.returned * (fitShare ?? 1)) / b.sold : null,
    };
  }
  return out;
}

// Share of a style's returns that were for size or fit: its own AfterShip
// reasons, leaning on the store's share when it has few.
function styleFitShare(stats, base) {
  if (base?.fitShare == null) return 1;
  const all = reasonTotal(stats.reasons);
  if (!all) return base.fitShare;
  return (fitReasons(stats.reasons) + PRIOR_REASONS * base.fitShare) / (all + PRIOR_REASONS);
}

// How it fits, in words, when the evidence leans clearly one way: reviewers'
// answers first (5 or more), else AfterShip's too-small vs too-large returns
// (10 or more, two to one). "" when it's mixed or unknown.
export function fitDirection(stats) {
  const lean = (c, min) => {
    const n = num(c.low) + num(c.true) + num(c.high);
    if (n < min) return null;
    if (c.low / n >= 0.25 && c.low >= 2 * c.high) return "low";
    if (c.high / n >= 0.25 && c.high >= 2 * c.low) return "high";
    return c.true / n >= 0.6 ? "true" : "";
  };
  const size = lean(stats.size || {}, FIT_MIN_ANSWERS);
  if (size === "low") return "small";
  if (size === "high") return "large";
  const width = lean(stats.width || {}, FIT_MIN_ANSWERS);
  if (width === "low") return "narrow";
  if (width === "high") return "wide";
  if (size === "true") return "true";
  if (size == null) {
    const r = stats.reasons || {};
    const small = num(r.small), large = num(r.large);
    if (small + large >= 10) {
      if (small >= 2 * large) return "small";
      if (large >= 2 * small) return "large";
    }
  }
  return "";
}

// A style's score, 1–99: the chance it fits as expected, from two views —
// reviewers who said it fit (true to size and width), and buyers who didn't
// send it back for fit — each leaning on the store's average when it has
// little data, then weighed by how much each has. null below the minimums.
export function fitScore(stats, base = {}) {
  const answered = num(stats?.answered);
  const sold = num(stats?.sold);
  if (answered < FIT_MIN_ANSWERS && sold < FIT_MIN_SOLD) return null;
  let sum = 0;
  let weight = 0;
  let reviews = null;
  let kept = null;
  if (answered > 0 && base.reviewFit != null) {
    reviews = (num(stats.fits) + PRIOR_ANSWERS * base.reviewFit) / (answered + PRIOR_ANSWERS);
    const w = answered / (answered + 20);
    sum += w * reviews; weight += w;
  }
  if (sold > 0) {
    const share = styleFitShare(stats, base);
    const fitReturns = Math.min(num(stats.returned), sold) * share;
    const baseRate = base.fitReturnRate ?? fitReturns / sold;
    kept = clamp01(1 - (fitReturns + PRIOR_SOLD * baseRate) / (sold + PRIOR_SOLD));
    const w = sold / (sold + 100);
    sum += w * kept; weight += w;
  }
  if (!weight) return null;
  return {
    score: Math.max(1, Math.min(99, Math.round((sum / weight) * 100))),
    label: fitDirection(stats),
    reviews: answered,
    sold,
    parts: { reviews, kept },
  };
}

// The same, for one size of the style (a signed-in shopper's own): the
// reviewers' view stays the style's; the buyers' view is that size's pairs,
// leaning on the style's own rate when the size has few. null when the size
// sold too few pairs to say.
export function fitScoreForSize(stats, sizeKey, base = {}) {
  const style = fitScore(stats, base);
  const z = stats?.sizes?.[sizeKey];
  if (!style || !z || num(z.sold) < FIT_MIN_SIZE_SOLD) return null;
  const share = styleFitShare(stats, base);
  const styleRate = num(stats.sold) > 0 ? (Math.min(num(stats.returned), num(stats.sold)) * share) / num(stats.sold) : (base.fitReturnRate ?? 0);
  const sold = num(z.sold);
  const kept = clamp01(1 - (Math.min(num(z.returned), sold) * share + PRIOR_SIZE_SOLD * styleRate) / (sold + PRIOR_SIZE_SOLD));
  let sum = 0;
  let weight = 0;
  if (style.parts.reviews != null) {
    const w = style.reviews / (style.reviews + 20);
    sum += w * style.parts.reviews; weight += w;
  }
  const w = sold / (sold + 100);
  sum += w * kept; weight += w;
  return { score: Math.max(1, Math.min(99, Math.round((sum / weight) * 100))), label: style.label, reviews: style.reviews, sold, size: sizeKey };
}

// What a product card carries: { s: score, l: label key, r: reviews, n: pairs
// sold } — or, for a shopper's own size, also z: the size.
export function cardFit(score) {
  if (!score || !Number.isFinite(score.score)) return null;
  const out = { s: score.score, r: score.reviews || 0, n: score.sold || 0 };
  if (score.label && FIT_LABELS[score.label]) out.l = score.label;
  if (score.size) out.z = String(score.size);
  return out;
}

// In words, for a screen reader or a tooltip.
export function fitSentence(fit) {
  if (!fit || !Number.isFinite(fit.s)) return "";
  const basis = [
    fit.r ? `${fit.r.toLocaleString("en-US")} ${fit.r === 1 ? "review" : "reviews"}` : "",
    fit.n ? `${fit.n.toLocaleString("en-US")} ${fit.n === 1 ? "pair" : "pairs"} sold in the last year` : "",
  ].filter(Boolean).join(" and ");
  const label = fit.l && FIT_LABELS[fit.l] ? `, ${FIT_LABELS[fit.l].toLowerCase()}` : "";
  const who = fit.z ? ` in size ${fit.z}, the size you've kept before` : "";
  return `Fit confidence${who}: ${fit.s}%${label}.${basis ? ` From ${basis}.` : ""}`;
}
