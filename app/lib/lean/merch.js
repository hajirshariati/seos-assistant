// Lean engine — merchandising. Among products that match what the customer
// asked for equally well, the ones that sell come first: the most sizes still
// in stock (shoes), the best rated, the store's best sellers. A shoe down to
// one odd size is cheap for a reason, so it no longer wins just on price.
// Relevance always comes first (search.js); this only orders within it. Pure.

import { productKind } from "./catalog.js";

export const MERCH_WEIGHTS = { stock: 0.45, rating: 0.35, badge: 0.2 };
// A shoe with fewer than this share of its sizes in stock is "few sizes left".
export const FEW_SIZES_SHARE = 0.34;

const clamp = (n) => Math.max(0, Math.min(1, n));

// The store's sizes for a product (all variants) and how many are in stock.
export function sizeCoverage(p = {}) {
  const key = Object.keys(p.options || {}).find((k) => /^size$/i.test(k));
  const all = key ? new Set(p.options[key].map((s) => String(s).trim().toLowerCase()).filter(Boolean)).size : 0;
  const inStock = Array.isArray(p.sizes) ? p.sizes.length : 0;
  return { all, inStock, share: all ? clamp(inStock / all) : 1 };
}

// "4.1", "4.1 out of 5", or the rating metafield's JSON ({"value":"4.1",…}).
function firstNumber(v) {
  const s = String(v ?? "");
  const m = s.match(/"value"\s*:\s*"?(\d+(?:\.\d+)?)/) || s.match(/\d+(?:\.\d+)?/);
  const n = m ? Number(m[1] ?? m[0]) : NaN;
  return Number.isFinite(n) ? n : NaN;
}

export function ratingOf(p = {}) {
  const a = p.attributes || {};
  const rating = firstNumber(a.rating);
  const count = firstNumber(a.review_count);
  return { rating: rating > 0 && rating <= 5 ? rating : NaN, count: count >= 0 ? Math.round(count) : NaN };
}

// Few reviews pull toward an average score, so 5.0 from 2 reviews doesn't
// outrank 4.6 from 400. No reviews: neutral.
function ratingScore(p) {
  const { rating, count } = ratingOf(p);
  if (!Number.isFinite(rating)) return 0.5;
  const n = Number.isFinite(count) && count > 0 ? count : 1;
  const prior = 4.2, weight = 8;
  const adjusted = (rating * n + prior * weight) / (n + weight);
  return clamp((adjusted - 3.5) / 1.5);
}

function badgeScore(p) {
  const b = String(p.badge || "").toLowerCase();
  if (!b) return 0.5;
  if (/final\s*sale|clearance/.test(b)) return 0;
  if (/best\s*-?\s*sell|top\s*rated|most\s*popular|fan\s*fav/.test(b)) return 1;
  if (/\bnew\b|just\s*in|arrival/.test(b)) return 0.8;
  if (/exclusive|limited/.test(b)) return 0.7;
  return 0.5; // "Sale" and anything else: neutral — stock depth decides
}

// 0..1. sizeFiltered: the customer named a size and every match has it in
// stock, so how many other sizes are left doesn't matter to them.
export function merchScore(p = {}, { sizeFiltered = false } = {}) {
  const stock = productKind(p) === "footwear" && !sizeFiltered ? sizeCoverage(p).share : 1;
  return MERCH_WEIGHTS.stock * stock + MERCH_WEIGHTS.rating * ratingScore(p) + MERCH_WEIGHTS.badge * badgeScore(p);
}

// A shoe down to its last few sizes (only when it has enough sizes to tell).
export function fewSizesLeft(p = {}) {
  if (productKind(p) !== "footwear") return false;
  const c = sizeCoverage(p);
  return c.all >= 4 && c.share < FEW_SIZES_SHARE;
}
