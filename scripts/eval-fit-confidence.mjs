// Fit confidence on product cards: how reviewers' fit answers, return
// reasons and sales are read and scored, and what a card carries. With
// TEST_DATABASE_URL set, a whole read also runs against a migrated Postgres
// with stand-ins for Shopify's sales report, Yotpo and AfterShip.
//
// Run: node scripts/eval-fit-confidence.mjs
//      TEST_DATABASE_URL=postgresql://... node scripts/eval-fit-confidence.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
import {
  fitStyleKey, reviewFit, tallyReviewFit, returnReasonKind, emptyFitStats, fitBaselines, fitDirection,
  fitScore, fitScoreForSize, cardFit, fitSentence, fitLevel, parseFitLevels, FIT_LABELS, FIT_MIN_ANSWERS, FIT_MIN_SOLD,
} from "../app/lib/fit-confidence.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.stack?.split("\n").slice(0, 3).join("\n      ") || err.message}`); }
}

// Yotpo's widget API review (custom_fields keyed "--<question id>").
const v1 = (id, size, width, extra = {}) => ({
  id, score: 5, content: "Great",
  custom_fields: {
    "--114563": { title: "Arch Support", form_id: 110132, field_type: "Rating", value: 4 },
    ...(size != null ? { "--114564": { title: "Size", form_id: 110132, field_type: "Size", value: size } } : {}),
    ...(width != null ? { "--114565": { title: "Width", form_id: 110132, field_type: "Size", value: width } } : {}),
    "--114569": { title: "Foot Conditions", form_id: 110132, field_type: "MultipleChoice", value: "Heel Pain" },
  },
  ...extra,
});

console.log("\nstyles");
await test("every color of a style is one style; men's and women's lines stay apart", () => {
  const a = fitStyleKey({ style: "Chase Arch Support Sneaker", gender: ["men"] });
  assert.equal(a, "chase arch support sneaker|m");
  assert.equal(fitStyleKey({ style: "Chase  Arch Support Sneaker", gender: ["Men's"] }), a);
  assert.equal(fitStyleKey({ style: "Chase Arch Support Sneaker", gender: ["women"] }), "chase arch support sneaker|w");
  assert.equal(fitStyleKey({ style: "Unity Sneaker", gender: ["men", "women"] }), "unity sneaker");
  assert.equal(fitStyleKey({ style: "Unity Sneaker" }), "unity sneaker");
  assert.equal(fitStyleKey({ style: "" }), "");
});

console.log("\nreviewers' fit answers");
await test("Yotpo's Size and Width answers (1 · 2 · 3) read as runs small / true / runs large; other questions ignored", () => {
  assert.deepEqual(reviewFit(v1(1, 1, 1)), { size: "low", width: "low" });
  assert.deepEqual(reviewFit(v1(2, 2, 2)), { size: "true", width: "true" });
  assert.deepEqual(reviewFit(v1(3, 3, 3)), { size: "high", width: "high" });
  assert.deepEqual(reviewFit(v1(4, "2", null)), { size: "true", width: null });
  assert.deepEqual(reviewFit({ id: 5 }), { size: null, width: null });
  assert.deepEqual(reviewFit({ id: 6, custom_fields: null }), { size: null, width: null });
});
await test("the newer storefront shape (customFields, fieldType) and answers in words read the same", () => {
  const v3 = { id: 7, customFields: { 114564: { title: "Size", fieldType: "Size", value: 2 }, 114565: { title: "Width", fieldType: "Size", value: 3 } } };
  assert.deepEqual(reviewFit(v3), { size: "true", width: "high" });
  const words = { id: 8, custom_fields: { "--1": { title: "How did it fit?", field_type: "SingleChoice", value: "Runs Small" }, "--2": { title: "Width", field_type: "SingleChoice", value: "True to Width" } } };
  assert.deepEqual(reviewFit(words), { size: "low", width: "true" });
  assert.deepEqual(reviewFit({ id: 9, custom_fields: { "--3": { title: "Width", field_type: "SingleChoice", value: "Runs Wide" } } }), { size: null, width: "high" });
});
await test("a 1–5 rating titled Fit is never read as runs small / large", () => {
  const rating = { id: 10, custom_fields: { "--1": { title: "Fit", field_type: "Rating", value: 1 } } };
  assert.deepEqual(reviewFit(rating), { size: null, width: null });
});
await test("each review counts once (a style's colors share reviews); it fits when every answer is true", () => {
  const t = tallyReviewFit([v1(1, 2, 2), v1(1, 2, 2), v1(2, 1, 2), v1(3, 2, null), v1(4, null, null), { id: 5 }, null]);
  assert.equal(t.reviews, 5);
  assert.equal(t.answered, 3);
  assert.equal(t.fits, 2);
  assert.deepEqual(t.size, { low: 1, true: 2, high: 0 });
  assert.deepEqual(t.width, { low: 0, true: 2, high: 0 });
});

console.log("\nreturn reasons");
await test("AfterShip's reasons sort into too small / too large / narrow / wide / another fit reason / not fit", () => {
  const cases = {
    "Too Small": "small", "Too short": "small", "Too tight": "small", "Need a larger size": "small", "Size up": "small",
    "Too Large": "large", "Too big": "large", "Need a smaller size": "large", "Too loose": "large",
    "Too Narrow": "narrow", "Too Wide": "wide",
    "Wrong size": "fit", "Didn't fit": "fit", "Sizing": "fit",
    "Changed my mind": "other", "Damaged or defective": "other", "Not as described": "other", "Other": "other", "": "other",
  };
  for (const [reason, kind] of Object.entries(cases)) assert.equal(returnReasonKind(reason), kind, reason);
  assert.equal(returnReasonKind({ name: "Too small" }), "small");
  assert.equal(returnReasonKind("Wrong size", "Too large"), "large");
});

console.log("\nscores");
const S = (over) => ({ ...emptyFitStats(), kind: "footwear", ...over });
const BASE = { reviewFit: 0.8, fitShare: 0.6, fitReturnRate: 0.1 };
await test("the score, worked by hand: reviewers and buyers, each leaning on the store's average", () => {
  const stats = S({ answered: 40, fits: 36, size: { low: 2, true: 36, high: 2 }, sold: 500, returned: 100, reasons: { small: 30, large: 10, narrow: 0, wide: 0, fit: 0, other: 40 } });
  // reviews (36 + 10·0.8)/(40 + 10) = 0.88, weight 40/60; fit share (40 + 10·0.6)/(80 + 10);
  // kept 1 − (100·share + 50·0.1)/(500 + 50) = 0.898, weight 500/600 → 0.890.
  const r = fitScore(stats, BASE);
  assert.equal(r.score, 89);
  assert.equal(r.label, "true");
  assert.equal(r.reviews, 40);
  assert.equal(r.sold, 500);
  // Where it comes from: the answers, and 1 − 100·share/500 = 90% not sent back for fit.
  assert.deepEqual(cardFit(r), { s: 89, v: "high", r: 40, n: 500, l: "true", a: [2, 36, 2], k: 90, kf: 1 });
});
await test("too little to go on → no score", () => {
  assert.equal(fitScore(S({ answered: FIT_MIN_ANSWERS - 1, fits: 4, sold: FIT_MIN_SOLD - 1, returned: 0 }), BASE), null);
  assert.ok(fitScore(S({ answered: FIT_MIN_ANSWERS, fits: 5 }), BASE));
  assert.ok(fitScore(S({ sold: FIT_MIN_SOLD, returned: 3 }), BASE));
});
await test("more returns, and more 'runs small' answers, mean a lower score", () => {
  const good = fitScore(S({ answered: 50, fits: 46, sold: 800, returned: 60 }), BASE).score;
  const returned = fitScore(S({ answered: 50, fits: 46, sold: 800, returned: 240 }), BASE).score;
  const small = fitScore(S({ answered: 50, fits: 30, sold: 800, returned: 60 }), BASE).score;
  assert.ok(returned < good, `${returned} < ${good}`);
  assert.ok(small < good, `${small} < ${good}`);
});
await test("returns for other reasons count less once AfterShip says why; without AfterShip every return counts", () => {
  const fitty = S({ sold: 500, returned: 100, reasons: { small: 40, large: 30, narrow: 0, wide: 0, fit: 0, other: 10 } });
  const other = S({ sold: 500, returned: 100, reasons: { small: 5, large: 5, narrow: 0, wide: 0, fit: 0, other: 70 } });
  assert.ok(fitScore(other, BASE).score > fitScore(fitty, BASE).score);
  const noAs = { reviewFit: null, fitShare: null, fitReturnRate: 0.2 };
  // 1 − (100 + 50·0.2)/(500 + 50) = 0.8
  assert.equal(fitScore(S({ sold: 500, returned: 100 }), noAs).score, 80);
});
await test("a style with few sales stays near the store's average", () => {
  const few = fitScore(S({ sold: 40, returned: 20 }), { ...BASE, fitShare: null, fitReturnRate: 0.1 });
  const many = fitScore(S({ sold: 4000, returned: 2000 }), { ...BASE, fitShare: null, fitReturnRate: 0.1 });
  assert.ok(few.score > many.score + 20, `${few.score} vs ${many.score}`);
});
await test("how it fits, in words: reviewers first; AfterShip's too-small vs too-large when there are few reviews", () => {
  assert.equal(fitDirection(S({ size: { low: 4, true: 6, high: 0 } })), "small");
  assert.equal(fitDirection(S({ size: { low: 0, true: 6, high: 4 } })), "large");
  assert.equal(fitDirection(S({ size: { low: 3, true: 4, high: 3 } })), "");
  assert.equal(fitDirection(S({ size: { low: 0, true: 9, high: 1 }, width: { low: 0, true: 6, high: 4 } })), "wide");
  assert.equal(fitDirection(S({ size: { low: 0, true: 9, high: 1 }, width: { low: 4, true: 6, high: 0 } })), "narrow");
  assert.equal(fitDirection(S({ size: { low: 0, true: 9, high: 1 } })), "true");
  assert.equal(fitDirection(S({ reasons: { small: 14, large: 5, narrow: 0, wide: 0, fit: 0, other: 0 } })), "small");
  assert.equal(fitDirection(S({ reasons: { small: 6, large: 3, narrow: 0, wide: 0, fit: 0, other: 0 } })), "", "fewer than 10");
  assert.equal(fitDirection(S({ size: { low: 0, true: 5, high: 0 }, reasons: { small: 30, large: 1, narrow: 0, wide: 0, fit: 0, other: 0 } })), "true", "reviewers first");
});
await test("one size of the style: its own pairs, leaning on the style's rate; too few pairs → none", () => {
  const stats = S({ answered: 40, fits: 36, size: { low: 2, true: 36, high: 2 }, sold: 500, returned: 100, reasons: { small: 30, large: 10, narrow: 0, wide: 0, fit: 0, other: 40 }, sizes: { 9: { sold: 100, returned: 40 }, 11: { sold: 19, returned: 0 } } });
  const nine = fitScoreForSize(stats, "9", BASE);
  assert.equal(nine.score, 85);
  assert.equal(nine.size, "9");
  // In size 9: 1 − 40·share/100 = 80% not sent back for fit; the style's numbers stay.
  assert.deepEqual(cardFit(nine), { s: 85, v: "high", r: 40, n: 500, l: "true", a: [2, 36, 2], k: 90, kf: 1, z: "9", zn: 100, zk: 80 });
  assert.equal(fitScoreForSize(stats, "11", BASE), null);
  assert.equal(fitScoreForSize(stats, "12", BASE), null);
});
await test("the store's averages are per kind of product", () => {
  const b = fitBaselines([
    S({ answered: 10, fits: 8, sold: 100, returned: 20, reasons: { small: 6, large: 0, narrow: 0, wide: 0, fit: 0, other: 4 } }),
    S({ kind: "orthotic", sold: 1000, returned: 50 }),
  ]);
  assert.equal(b.footwear.reviewFit, 0.8);
  assert.equal(b.footwear.fitShare, 0.6);
  assert.ok(Math.abs(b.footwear.fitReturnRate - 0.12) < 1e-9);
  assert.equal(b.orthotic.reviewFit, null);
  assert.equal(b.orthotic.fitShare, null);
  assert.equal(b.orthotic.fitReturnRate, 0.05);
});

console.log("\nwhat a card carries");
await test("the score in a word: High from 85, Mid from 70, Fair below; the store's choice of levels, High and Mid unless it says", () => {
  assert.deepEqual([99, 85, 84, 70, 69, 1].map(fitLevel), ["high", "high", "mid", "mid", "fair", "fair"]);
  assert.equal(fitLevel(undefined), null);
  assert.equal(fitLevel("abc"), null);
  assert.deepEqual(parseFitLevels(undefined), ["high", "mid"]);
  assert.deepEqual(parseFitLevels(null), ["high", "mid"]);
  assert.deepEqual(parseFitLevels("fair, HIGH"), ["high", "fair"], "in order, tidied");
  assert.deepEqual(parseFitLevels("high,mid,fair,extra"), ["high", "mid", "fair"]);
  assert.deepEqual(parseFitLevels(""), [], "none ticked → none");
});
await test("score, words, reviews and pairs; a shopper's own size when there is one; said in full for screen readers", () => {
  assert.deepEqual(cardFit({ score: 92, label: "true", reviews: 85, sold: 1240 }), { s: 92, v: "high", r: 85, n: 1240, l: "true" });
  assert.deepEqual(cardFit({ score: 70, label: "", reviews: 0, sold: 300, answers: { size: [0, 0, 0], width: [0, 0, 0] }, kept: 81, fitOnly: false }), { s: 70, v: "mid", r: 0, n: 300, k: 81 });
  assert.deepEqual(cardFit({ score: 94, label: "true", reviews: 85, sold: 1240, answers: { size: [8, 72, 5], width: [3, 70, 2] }, kept: 88, fitOnly: true, size: "9", sizeSold: 412, sizeKept: 90 }),
    { s: 94, v: "high", r: 85, n: 1240, l: "true", a: [8, 72, 5], w: [3, 70, 2], k: 88, kf: 1, z: "9", zn: 412, zk: 90 });
  assert.equal(cardFit(null), null);
  assert.equal(fitSentence({ s: 92, l: "true", r: 85, n: 1240 }), "Fit confidence: High. Runs true to size. From 85 reviews and 1,240 pairs sold in the last year.");
  assert.equal(fitSentence({ s: 64, l: "small", r: 20, n: 0 }), "Fit confidence: Fair. Runs small. From 20 reviews.");
  assert.equal(fitSentence({ s: 94, r: 1, n: 0, z: "9" }), "Fit confidence in size 9, the size you've kept before: High. From 1 review.");
  assert.deepEqual(Object.keys(FIT_LABELS), ["true", "small", "large", "narrow", "wide"]);
});

// ── a whole read, against Postgres ──
if (!process.env.TEST_DATABASE_URL) {
  console.log("\n(skipped the database read: set TEST_DATABASE_URL to a migrated test database)");
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.ENCRYPTION_KEY ||= "0".repeat(64);
  const HOOK = `export async function resolve(spec, ctx, next) {
    try { return await next(spec, ctx); } catch (e) {
      if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
      throw e;
    }
  }`;
  register("data:text/javascript," + encodeURIComponent(HOOK));
  const { default: prisma } = await import("../app/db.server.js");
  const F = await import("../app/lib/fit-confidence.server.js");
  const { loadLeanCatalog, reloadLeanCatalog } = await import("../app/lib/lean/catalog.server.js");
  const { toCard } = await import("../app/lib/lean/engine.js");
  const { updateShopConfig, forgetShopConfig } = await import("../app/models/ShopConfig.server.js");
  const SHOP = `eval-fit-${Date.now()}.myshopify.com`;
  const NOW = new Date();
  const daysAgo = (d) => new Date(NOW.getTime() - d * 864e5);

  const product = (id, title, { type = "Footwear", gender = "", status = "ACTIVE", sizes = [] } = {}) => ({
    shop: SHOP, shopifyId: `gid://shopify/Product/${id}`, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title, productType: type, status,
    attributesJson: gender ? { gender } : {},
    variants: { create: sizes.map(([vid, size]) => ({ shopifyId: `gid://shopify/ProductVariant/${vid}`, title: size, price: "120.00", inventoryQty: 5, optionsJson: JSON.stringify([{ name: "Size", value: size }, { name: "Width", value: "medium" }]) })) },
  });
  for (const p of [
    product(101, "Chase Arch Support Sneaker - Black", { gender: "Men", sizes: [[1011, "8.5 - 9 US"], [1012, "10 US"]] }),
    product(102, "Chase Arch Support Sneaker - Navy", { gender: "Men", status: "DRAFT", sizes: [[1021, "8.5 - 9 US"]] }),
    product(201, "Maui Orthotic Women's Flips - Black", { gender: "Women", sizes: [[2011, "8 US"]] }),
    product(301, "Premium Memory Foam Orthotics", { type: "Orthotics", sizes: [[3011, "9 US"]] }),
    product(401, "Performance Socks", { type: "Accessories", sizes: [[4011, "M"]] }),
  ]) await prisma.product.create({ data: p });
  await updateShopConfig(SHOP, { yotpoApiKey: "yotpo-app-key", aftershipApiKey: "as-key", fitConfidenceEnabled: true });

  // Shopify's sales report (and a shopper's own purchases).
  const reports = [];
  const graphql = async (query) => {
    reports.push(query);
    const ql = JSON.parse(query.match(/shopifyqlQuery\(query: (".*")\)/)[1]);
    if (/customer_id = 555/.test(ql)) {
      return { data: { shopifyqlQuery: { parseErrors: [], tableData: { rows: [
        { product_id: "101", product_variant_title: "medium / 8.5 - 9 US", quantity_ordered: "2", quantity_returned: "0" },
        { product_id: "201", product_variant_title: "8 US", quantity_ordered: "1", quantity_returned: "0" },
        { product_id: "301", product_variant_title: "11 US", quantity_ordered: "3", quantity_returned: "0" },
      ] } } } };
    }
    return { data: { shopifyqlQuery: { parseErrors: [], tableData: { rows: [
      { product_id: "0", product_variant_id: "0", quantity_ordered: "999", quantity_returned: "0" },
      { product_id: "101", product_variant_id: "1011", quantity_ordered: "300", quantity_returned: "-60" },
      { product_id: "101", product_variant_id: "1012", quantity_ordered: "200", quantity_returned: "-20" },
      { product_id: "102", product_variant_id: "1021", quantity_ordered: "100", quantity_returned: "-20" },
      { product_id: "201", product_variant_id: "2011", quantity_ordered: "400", quantity_returned: "-20" },
      { product_id: "301", product_variant_id: "3011", quantity_ordered: "1000", quantity_returned: "-50" },
      { product_id: "401", product_variant_id: "4011", quantity_ordered: "50", quantity_returned: "-1" },
      { product_id: "999", product_variant_id: "9991", quantity_ordered: "10", quantity_returned: "-1" },
    ] } } } };
  };

  // Yotpo (Chase's two colors share their reviews) and AfterShip.
  const chaseReviews = [...Array(8)].map((_, i) => v1(1000 + i, 2, 2)).concat([v1(1100, 1, 2), v1(1101, 3, 2)]);
  const mauiReviews = [...Array(6)].map((_, i) => v1(2000 + i, 1, 2)).concat([v1(2100, 2, 2), v1(2101, 2, 2)]);
  const asReturns = [
    { id: "ret1", created_at: daysAgo(10).toISOString(), return_items: [
      { id: "i1", external_product_id: "101", external_variant_id: "1011", return_reason: "Too Small", intended_return_quantity: 10 },
      { id: "i2", external_product_id: "101", external_variant_id: "1012", return_reason: "Too Large", intended_return_quantity: 5 },
      { id: "i3", external_product_id: "101", return_reason: "Changed my mind", intended_return_quantity: 5 },
    ] },
    { id: "ret2", created_at: daysAgo(40).toISOString(), return_items: [
      { id: "i4", external_product_id: "201", return_reason: "Too Small", intended_return_quantity: 4 },
      { id: "i5", external_product_id: "999", return_reason: "Too Small", intended_return_quantity: 1 },
    ] },
  ];
  const calls = { yotpo: [], aftership: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
    if (u.hostname === "api.yotpo.com") {
      calls.yotpo.push(u.pathname);
      const pid = u.pathname.match(/products\/(\d+)\//)[1];
      const list = pid === "101" || pid === "102" ? chaseReviews : pid === "201" ? mauiReviews : pid === "301" ? [{ id: 3000, content: "Good" }] : [];
      return json({ status: { code: 200 }, response: { pagination: { page: 1, per_page: 150, total: list.length }, reviews: list } });
    }
    if (u.hostname === "api.aftership.com") {
      calls.aftership.push({ path: u.pathname, key: opts.headers?.["as-api-key"], from: u.searchParams.get("created_at_min"), to: u.searchParams.get("created_at_max"), page: u.searchParams.get("page") });
      const from = new Date(u.searchParams.get("created_at_min")), to = new Date(u.searchParams.get("created_at_max"));
      return json({ meta: { code: 200 }, data: { returns: asReturns.filter((r) => new Date(r.created_at) >= from && new Date(r.created_at) < to) } });
    }
    throw new Error(`unexpected ${url}`);
  };
  const config = { yotpoApiKey: "yotpo-app-key", aftershipApiKey: "as-key" };

  console.log("\nthe whole read (Postgres)");
  let saved;
  await test("a read: sales per style and size, each review once, returns by reason — saved with what each source gave", async () => {
    await prisma.fitReturnItem.create({ data: { shop: SHOP, id: "old", productId: "101", kind: "small", qty: 99, returnedAt: daysAgo(400) } });
    const r = await F.refreshFitData(SHOP, { graphql, config, fetchImpl, now: NOW, pauseMs: 0 });
    saved = r.data;
    const chase = saved.styles["chase arch support sneaker|m"];
    assert.equal(chase.name, "Chase Arch Support Sneaker");
    assert.equal(chase.sold, 600);
    assert.equal(chase.returned, 100);
    assert.deepEqual(chase.sizes, { 8.5: { sold: 400, returned: 80 }, 9: { sold: 400, returned: 80 }, 10: { sold: 200, returned: 20 } });
    assert.equal(chase.answered, 10, "the two colors' shared reviews count once");
    assert.equal(chase.fits, 8);
    assert.deepEqual(chase.reasons, { small: 10, large: 5, narrow: 0, wide: 0, fit: 0, other: 5 });
    assert.equal(chase.card.l, "true");
    assert.ok(chase.card.s >= 1 && chase.card.s <= 99);
    const maui = saved.styles["maui orthotic women's flips|w"];
    assert.equal(maui.card.l, "small");
    assert.ok(maui.card.s < chase.card.s, "runs small, lower score");
    const orthotic = saved.styles["premium memory foam orthotics"];
    assert.equal(orthotic.kind, "orthotic");
    assert.equal(orthotic.answered, 0);
    assert.equal(orthotic.card.l, undefined);
    assert.equal(saved.styles["performance socks"], undefined, "not shoes or orthotics");
    assert.equal(saved.pid["101"], "chase arch support sneaker|m");
    assert.equal(r.status.sales.ok, true);
    assert.equal(r.status.sales.sold, 2000);
    assert.equal(r.status.sales.returned, 170);
    assert.equal(r.status.reviews.ok, true);
    assert.equal(r.status.reviews.answered, 18);
    assert.equal(r.status.returns.ok, true);
    assert.equal(r.status.returns.items, 24, "the unknown product's item and the 400-day-old one don't count");
    assert.equal(r.status.returns.fit, 19);
    assert.equal(r.status.styles, 3);
    assert.equal(await prisma.fitReturnItem.count({ where: { shop: SHOP, id: "old" } }), 0, "older than 12 months: deleted");
    assert.ok(calls.aftership.every((c) => c.key === "as-key" && /^\/returns\/[\d-]+\/returns$/.test(c.path)));
    assert.ok(calls.aftership.length >= 52 && calls.aftership.length <= 54, `a week at a time over a year: ${calls.aftership.length}`);
  });
  await test("the next read asks AfterShip only for what's new (from three days before the last read)", async () => {
    calls.aftership.length = 0;
    const r = await F.refreshFitData(SHOP, { graphql, config, fetchImpl, now: new Date(NOW.getTime() + 864e5), pauseMs: 0 });
    assert.equal(calls.aftership.length, 1);
    assert.ok(new Date(calls.aftership[0].from) >= daysAgo(3) - 1000);
    assert.equal(r.status.returns.items, 24, "items already kept aren't counted twice");
  });
  await test("a source that fails says so in plain words; the others still count", async () => {
    const bad = async (url) => {
      if (String(url).includes("yotpo")) return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
      return { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) };
    };
    const noReports = async () => ({ errors: [{ message: "Access denied for shopifyqlQuery field. Required access: `read_reports` access scope." }] });
    const before = (await prisma.fitData.findUnique({ where: { shop: SHOP } })).data.styles;
    const r = await F.refreshFitData(SHOP, { graphql: noReports, config, fetchImpl: bad, now: new Date(NOW.getTime() + 2 * 864e5), pauseMs: 0 });
    assert.match(r.status.sales.error, /reports permission.*The last read's numbers are kept/);
    assert.match(r.status.reviews.error, /Yotpo didn't accept the app key.*The last read's numbers are kept/);
    assert.match(r.status.returns.error, /AfterShip refused the API key/);
    assert.equal(r.status.returns.items, 24, "returns kept from before still count");
    for (const key of Object.keys(before)) {
      assert.deepEqual(r.data.styles[key].card, before[key].card, `${key}: a failed read doesn't move its score`);
      assert.deepEqual(r.data.styles[key].sizes, before[key].sizes);
    }
    const none = await F.refreshFitData(SHOP, { graphql, config: {}, fetchImpl, now: new Date(NOW.getTime() + 3 * 864e5), pauseMs: 0 });
    assert.match(none.status.reviews.error, /Add the Yotpo app key/);
    assert.match(none.status.returns.error, /Add the AfterShip API key/);
    // Back to the full read for what follows.
    saved = (await F.refreshFitData(SHOP, { graphql, config, fetchImpl, now: NOW, pauseMs: 0 })).data;
  });
  await test("every shoe and orthotic card carries its style's score; off in Smart Recommenders → none", async () => {
    F.forgetFitData(SHOP);
    let catalog = await reloadLeanCatalog(SHOP);
    const card = (handle) => toCard(catalog.products.find((p) => p.handle === handle));
    assert.deepEqual(card("chase-arch-support-sneaker-black").fit, saved.styles["chase arch support sneaker|m"].card);
    assert.equal(card("maui-orthotic-women-s-flips-black").fit.l, "small");
    assert.ok(card("premium-memory-foam-orthotics").fit);
    assert.equal(card("performance-socks").fit, undefined);
    await updateShopConfig(SHOP, { fitConfidenceEnabled: false });
    forgetShopConfig(SHOP);
    catalog = await reloadLeanCatalog(SHOP);
    assert.equal(card("chase-arch-support-sneaker-black").fit, undefined);
    await updateShopConfig(SHOP, { fitConfidenceEnabled: true });
    forgetShopConfig(SHOP);
    catalog = await reloadLeanCatalog(SHOP);
    assert.ok(card("chase-arch-support-sneaker-black").fit);
    assert.equal((await loadLeanCatalog(SHOP)).products.length, 4, "drafts stay out of the catalog");
  });
  await test("signed in: the size the shopper kept gives the card that size's score", async () => {
    const catalog = await loadLeanCatalog(SHOP);
    const cards = ["chase-arch-support-sneaker-black", "maui-orthotic-women-s-flips-black", "premium-memory-foam-orthotics"].map((h) => toCard(catalog.products.find((p) => p.handle === h)));
    const purchases = F.shopperPurchases({ shop: SHOP, customerId: "555", graphql });
    const out = await F.withShopperFit(cards, { shop: SHOP, catalog, purchases });
    assert.equal(out[0].fit.z, "8.5", "kept 8.5 - 9 in this style");
    assert.equal(out[0].fit.s, F.shopperFit(saved, "chase arch support sneaker|m", { usual: {}, kept: { "chase arch support sneaker|m": "8.5" } }).s);
    assert.equal(out[1].fit.z, "8", "their usual women's size (from the Maui they kept)");
    assert.equal(out[2].fit.z, undefined, "orthotics keep the style's score");
    assert.deepEqual(out[2].fit, cards[2].fit);
    assert.equal(F.shopperFit(saved, "chase arch support sneaker|m", { usual: { m: "11" }, kept: {} }), null, "a size that sold no pairs: none");
    assert.equal(F.shopperFit(saved, "chase arch support sneaker|m", { usual: { w: "8" }, kept: {} }), null, "a women's size says nothing about a men's style");
    assert.ok(reports.some((q) => /customer_id = 555/.test(q)));
  });
  await test("the shopper's usual size: the one kept most in that line, only when it's at least half their pairs", () => {
    const data = { pid: { 1: "a|w", 2: "b|w", 3: "c|w" }, styles: { "a|w": { kind: "footwear" }, "b|w": { kind: "footwear" }, "c|w": { kind: "footwear" } } };
    const one = F.shopperSizes([{ productId: "1", title: "8 US", ordered: 2, returned: 0 }, { productId: "2", title: "medium / 8 US", ordered: 1, returned: 0 }, { productId: "3", title: "9 US", ordered: 1, returned: 0 }], data);
    assert.deepEqual(one.usual, { w: "8" });
    const family = F.shopperSizes([{ productId: "1", title: "6 US", ordered: 1, returned: 0 }, { productId: "2", title: "8 US", ordered: 1, returned: 0 }, { productId: "3", title: "10 US", ordered: 1, returned: 0 }], data);
    assert.deepEqual(family.usual, {}, "mixed sizes: none");
    const sentBack = F.shopperSizes([{ productId: "1", title: "7 US", ordered: 1, returned: 1 }, { productId: "2", title: "8 US", ordered: 1, returned: 0 }], data);
    assert.deepEqual(sentBack.usual, { w: "8" }, "a pair sent back doesn't count");
    assert.deepEqual(F.titleSizeKeys("medium / 10.5 US"), ["10.5"]);
    assert.deepEqual(F.titleSizeKeys("9 - 9.5 US / Wide"), ["9", "9.5"]);
    assert.deepEqual(F.titleSizeKeys("Default Title"), []);
  });
  await test("a customer id that isn't a number never reaches the report; a slow report leaves the cards as they are", async () => {
    let asked = 0;
    const counting = async () => { asked++; return { data: { shopifyqlQuery: { parseErrors: [], tableData: { rows: [] } } } }; };
    assert.equal(await F.shopperPurchases({ shop: SHOP, customerId: "1 OR 1=1", graphql: counting }), null);
    assert.equal(await F.shopperPurchases({ shop: SHOP, customerId: "", graphql: counting }), null);
    assert.equal(asked, 0);
    const catalog = await loadLeanCatalog(SHOP);
    const cards = [toCard(catalog.products.find((p) => p.handle === "chase-arch-support-sneaker-black"))];
    const slow = new Promise((r) => setTimeout(() => r([{ productId: "101", title: "8.5 - 9 US", ordered: 1, returned: 0 }]), 400));
    const out = await F.withShopperFit(cards, { shop: SHOP, catalog, purchases: slow, waitMs: 50 });
    assert.deepEqual(out, cards);
  });
  await test("the admin summary: when it was read, what each source gave, the lowest scores first", async () => {
    const s = await F.fitSummary(SHOP);
    assert.ok(s.readAt);
    assert.equal(s.scored, 3);
    assert.equal(s.lowest[0].name, "Maui Orthotic Women's Flips");
    assert.equal(s.lowest[0].line, "Women's");
    assert.ok(s.lowest.every((x, i) => i === 0 || s.lowest[i - 1].s <= x.s));
    assert.equal(s.run.running, false);
    assert.equal(F.fitReadDue(s), false);
    assert.equal(F.fitReadDue({ readAt: daysAgo(2).toISOString() }), true);
    assert.equal(F.fitReadDue({ readAt: null }), true);
  });

  await prisma.fitReturnItem.deleteMany({ where: { shop: SHOP } });
  await prisma.fitData.deleteMany({ where: { shop: SHOP } });
  await prisma.product.deleteMany({ where: { shop: SHOP } });
  await prisma.shopConfig.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
