// Back-in-stock alerts (restock.js): a sold-out size, or a restock question,
// is checked against the exact variant and answered with a Notify-me card
// (Klaviyo back-in-stock for that Shopify variant) — never a guessed date,
// never customer service. Pure checks: the tool's answers, the reply guard,
// the tool's and the prompt rule's gating on the store's Klaviyo setup.
//
// Run: node scripts/eval-restock-alerts.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// The app's extension-less imports.
const HOOK = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
    throw e;
  }
}`;
register("data:text/javascript," + encodeURIComponent(HOOK));
const { restockCheck, restockIssues, RESTOCK_ASK, RESTOCK_TOOL, RESTOCK_TOOL_DEF } = await import("../app/lib/lean/restock.js");
const { buildLeanCatalog } = await import("../app/lib/lean/catalog.js");
const { buildLeanTools } = await import("../app/lib/lean/tools.js");
const { buildLeanSystemPrompt } = await import("../app/lib/lean/prompt.js");

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); }
};

// The Miles in Black, as the store has it (2026-10-30): size only, 13.5 - 14
// sold out, variant ids as Shopify gives them.
const miles = {
  handle: "miles-black-am260m", title: "Miles Arch Support Sneaker - Black", productType: "Footwear", status: "ACTIVE", featuredImageUrl: "https://img/miles.jpg",
  attributesJson: { category_for_filter: "Sneakers", gender: "men" },
  variants: [["8 US", 3, "51133383409977"], ["10.5 US", 49, "51133383508281"], ["13.5 - 14 US", 0, "gid://shopify/ProductVariant/51133383639353"]]
    .map(([size, qty, id]) => ({ shopifyId: id, sku: "AM260M", price: "139.95", inventoryQty: qty, optionsJson: JSON.stringify([{ name: "Size", value: size }]) })),
};
// A style sold in sizes and widths.
const blake = {
  handle: "blake-white", title: "Blake Comfort Sneaker - White", productType: "Footwear", status: "ACTIVE",
  attributesJson: { category_for_filter: "Sneakers", gender: "women" },
  variants: [["9 US", "Medium", 0, "1"], ["9 US", "Wide", 4, "2"], ["10 US", "Medium", 2, "3"]]
    .map(([size, width, qty, id]) => ({ shopifyId: id, price: "139.95", inventoryQty: qty, optionsJson: JSON.stringify([{ name: "Size", value: size }, { name: "Width", value: width }]) })),
};
// An old row without variant ids (a catalog synced before ids were kept).
const noIds = { ...miles, handle: "miles-navy", title: "Miles Arch Support Sneaker - Navy", variants: miles.variants.map((v) => ({ ...v, shopifyId: undefined })) };
const catalog = buildLeanCatalog([miles, blake, noIds], { shop: "s.myshopify.com" });
const P = Object.fromEntries(catalog.products.map((p) => [p.handle, p]));

console.log("\nthe catalog");
await test("each variant keeps its Shopify id (number or gid) with its options", () => {
  assert.deepEqual(P["miles-black-am260m"].variants, [
    { id: "51133383409977", options: { Size: "8 US" } },
    { id: "51133383508281", options: { Size: "10.5 US" } },
    { id: "51133383639353", options: { Size: "13.5 - 14 US" } },
  ]);
  assert.deepEqual(P["miles-navy"].variants.map((v) => v.id), ["", "", ""], "no id → empty, never a guess");
});

console.log("\nthe tool's answers");
await test("sold out in that size → the card for that exact variant, with the sizes in stock", () => {
  const r = restockCheck(P["miles-black-am260m"], { size: "13.5" });
  assert.equal(r.in_stock, false);
  assert.equal(r.alert, "offered");
  assert.deepEqual(r.options, { Size: "13.5 - 14 US" });
  assert.deepEqual(r.in_stock_sizes, ["8 US", "10.5 US"]);
  assert.match(r.note, /sold out right now/);
  assert.match(r.note, /Don't ask for their email in the chat/);
  assert.match(r.note, /don't send them to customer service/);
  assert.deepEqual(r._events, [{ type: "restock_cta", handle: "miles-black-am260m", title: "Miles Arch Support Sneaker - Black", image: "https://img/miles.jpg", variant: "51133383639353", choice: "13.5 - 14 US" }]);
});
await test("in stock right now → no card; show it with their size", () => {
  const r = restockCheck(P["miles-black-am260m"], { Size: "10.5" });
  assert.equal(r.in_stock, true);
  assert.equal(r._events, undefined);
  assert.match(r.note, /in stock right now — no alert needed/);
  assert.match(r.note, /show_products/);
});
await test("live stock wins over the synced catalog, both ways", () => {
  const back = restockCheck(P["miles-black-am260m"], { size: "13.5 - 14" }, [{ Size: "13.5 - 14 US" }]);
  assert.equal(back.in_stock, true, "restocked since the sync");
  const gone = restockCheck(P["miles-black-am260m"], { size: "8" }, [{ Size: "10.5 US" }]);
  assert.equal(gone.in_stock, false, "sold out since the sync");
  assert.equal(gone.alert, "offered");
  assert.deepEqual(gone.in_stock_sizes, ["10.5 US"]);
  assert.equal(gone._events[0].variant, "51133383409977");
});
await test("a size the store doesn't carry for it: not a stock gap, no card, the sizes it comes in", () => {
  const r = restockCheck(P["miles-black-am260m"], { size: "15" });
  assert.equal(r.carried, false);
  assert.equal(r._events, undefined);
  assert.deepEqual(r.comes_in, { Size: ["8 US", "10.5 US", "13.5 - 14 US"] });
  assert.match(r.note, /doesn't come in 15/);
  assert.match(r.note, /won't be restocked in it/);
});
await test("no size given, or only the size of a sized-and-widthed style: ask, don't guess", () => {
  const none = restockCheck(P["miles-black-am260m"], undefined);
  assert.equal(none.needs_options, true);
  assert.match(none.note, /Ask which size/);
  assert.equal(none._events, undefined);
  const half = restockCheck(P["blake-white"], { size: "9" });
  assert.equal(half.needs_options, true);
  assert.deepEqual(half.chosen, { Size: "9 US" });
  assert.deepEqual(half.still_needed, { Width: ["Medium", "Wide"] });
  assert.match(half.note, /which Width/);
  const full = restockCheck(P["blake-white"], { size: "9", width: "medium" });
  assert.equal(full.alert, "offered");
  assert.equal(full._events[0].variant, "1");
  assert.equal(full._events[0].choice, "9 US / Medium");
  assert.deepEqual(full.in_stock_sizes, ["10 US"], "the other size in stock in Medium");
});
await test("sold out but no variant id: said plainly, no card, no date", () => {
  const r = restockCheck(P["miles-navy"], { size: "13.5" });
  assert.equal(r.in_stock, false);
  assert.equal(r.alert, "unavailable");
  assert.equal(r._events, undefined);
  assert.match(r.note, /an alert can't be set for it here/);
  assert.match(r.note, /don't promise a restock date/);
});
await test("no product → search first", () => {
  assert.match(restockCheck(null, { size: "8" }).error, /No product with that handle/);
});

console.log("\nwhat counts as a restock question");
await test("restock asks, in shoppers' words", () => {
  for (const m of [
    "Any idea when the Miles in US 10.5 size will be back in stock?",
    "when will these be restocked",
    "Will you get the navy back in?",
    "is the 8 coming back",
    "can you notify me when it's available",
    "let me know when the wide is back",
    "when is the Jillian going to be available again in 9",
  ]) assert.ok(RESTOCK_ASK.test(m), m);
  for (const m of ["show me sneakers in 10.5", "do these run wide", "where is my order", "I want to return my shoes"]) assert.ok(!RESTOCK_ASK.test(m), m);
});

console.log("\nthe reply guard");
const base = { available: ["search_products", RESTOCK_TOOL, "contact_support"], called: ["search_products"] };
await test("a restock question handed to customer service, or closed without a question back: checked first", () => {
  const sent = restockIssues({ ...base, latestUserMessage: "when will the Miles be back in 10.5?", text: "I don't have restock dates — our customer service team can help.", supportOffered: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].code, "restock_not_checked");
  assert.match(sent[0].detail, /sending them to customer service instead of checking/);
  assert.match(sent[0].detail, new RegExp(RESTOCK_TOOL));
  const closed = restockIssues({ ...base, latestUserMessage: "will the 13.5 be restocked", text: "That size is sold out and I don't have a restock date, sorry.", supportOffered: false });
  assert.equal(closed[0]?.code, "restock_not_checked");
});
await test("asking back which product or size, or after the check, is fine", () => {
  assert.deepEqual(restockIssues({ ...base, latestUserMessage: "when will the Miles be back?", text: "Happy to check — which size are you after? <<8 US>><<10.5 US>>" }), []);
  assert.deepEqual(restockIssues({ ...base, called: ["search_products", RESTOCK_TOOL], latestUserMessage: "when will the Miles be back in 13.5?", text: "Sold out in 13.5 - 14 right now. Pop your email in below.", supportOffered: true }), []);
  assert.deepEqual(restockIssues({ available: ["search_products", "contact_support"], called: [], latestUserMessage: "when will the Miles be back in 13.5?", text: "No restock date, sorry.", supportOffered: true }), [], "a store without alerts");
  assert.deepEqual(restockIssues({ ...base, latestUserMessage: "when is it back? I want to talk to a person", text: "Of course — here's customer service.", supportOffered: true }), [], "they asked for a person");
});
await test("a sold-out size picked for a card: the alert is offered too", () => {
  const r = restockIssues({ ...base, latestUserMessage: "blaire in 6.5", text: "The Blaire is sold out in 6 - 6.5 US — 7 US is in stock.", soldOut: [{ title: "Blaire Adjustable Slide Sandal - Black", wanted: { Size: "6 - 6.5 US" }, in_stock: ["7 US"] }] });
  assert.equal(r.length, 1);
  assert.equal(r[0].code, "restock_not_offered");
  assert.match(r[0].detail, /Blaire Adjustable Slide Sandal - Black is sold out in 6 - 6.5 US/);
  assert.match(r[0].detail, /Notify-me card/);
});

console.log("\ngating on the store's Klaviyo setup");
await test("the tool exists only with a Klaviyo company id, right before contact_support", () => {
  const off = buildLeanTools(catalog.vocab, {});
  assert.ok(!off.some((t) => t.name === RESTOCK_TOOL));
  const on = buildLeanTools(catalog.vocab, { restockAlerts: true });
  const i = on.findIndex((t) => t.name === RESTOCK_TOOL);
  assert.ok(i > 0);
  assert.equal(on[i + 1].name, "contact_support");
  assert.equal(on[i], RESTOCK_TOOL_DEF);
  assert.deepEqual(RESTOCK_TOOL_DEF.input_schema.required, ["handle"]);
  assert.match(RESTOCK_TOOL_DEF.description, /never send a restock question to customer service/);
});
await test("the prompt rule reads only for those stores; other stores' prompts read as before", () => {
  const plain = buildLeanSystemPrompt({ config: {}, vocab: catalog.vocab, shop: "s" });
  const withAlerts = buildLeanSystemPrompt({ config: { klaviyoCompanyId: "AbC123" }, vocab: catalog.vocab, shop: "s" });
  assert.doesNotMatch(plain, /back_in_stock_alert/);
  assert.match(withAlerts, /check that exact size with back_in_stock_alert/);
  assert.match(withAlerts, /never guess one, and never send a restock question to customer service/);
  assert.match(withAlerts, /don't ask for their email in the chat; the card takes it/);
  assert.equal(withAlerts.replace(/\n- Sold out, or coming back:[^\n]*/, ""), plain, "one added line, nothing else changed");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
