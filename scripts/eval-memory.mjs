// Memory: ended offers and retired styles, from the store's own records only
// (app/lib/memory.js, the past-offers tool, the engine's retired note and
// its "no record, no claim" check).
//
// Run: node scripts/eval-memory.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// The app's extension-less imports, and no database (nothing here reads one).
const HOOK = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
    throw e;
  }
}`;
register("data:text/javascript," + encodeURIComponent(HOOK));
const noop = new Proxy(async () => [], { get: (t, k) => (k === "then" ? undefined : noop), apply: async () => [] });
global.prismaGlobal = new Proxy({}, { get: () => noop });
process.env.DATABASE_URL ||= "postgresql://x@localhost:1/none";

const M = await import("../app/lib/memory.js");
const { promoLines, diffPromoLines, lineSimilarity, offerWords, matchOffers, endedWording, pastOffersResult, retiredRowFromProduct, retiredStyleIndex, retiredStylesInText, retiredNote, liveStyleKeys, claimsFromMemory, titleColor, daysBetween, promoMemoryDays, styleMemoryDays, MEMORY_TZ } = M;
const { pastOffersTool, PAST_OFFERS_TOOL } = await import("../app/lib/lean/store-tools.server.js");
const { buildLeanCatalog, GENERIC_STYLE_WORDS } = await import("../app/lib/lean/catalog.js");
const { runLeanTurn } = await import("../app/lib/lean/engine.js");
const { buildLeanSystemPrompt } = await import("../app/lib/lean/prompt.js");
const { hasStopLine, cutPromoSection } = await import("../app/lib/promo-page.js");

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name} — ${e.message}`); }
};
const quiet = () => {};
const at = (s) => new Date(s);
const NOW = at("2026-11-03T15:00:00-05:00"); // a Tuesday afternoon, Eastern

console.log("\noffers: reading the promotions page");
const PAGE = `CURRENT OFFERS
• Free shipping on orders over $75 (lower 48 states).
20% off all boots with code FALL20 — ends 11/2.
Buy an orthotic, get a free pair of socks.

Spend $150, save $25.
STANDARD TERMS AND CONDITIONS OF SALE
Returns within 30 days…`;
await test("offer lines: one per line, three words or more, bullets and headings dropped, no repeats", () => {
  const lines = promoLines(cutPromoSection(PAGE, "STANDARD TERMS AND CONDITIONS OF SALE"));
  assert.deepEqual(lines, [
    "Free shipping on orders over $75 (lower 48 states).",
    "20% off all boots with code FALL20 — ends 11/2.",
    "Buy an orthotic, get a free pair of socks.",
    "Spend $150, save $25.",
  ]);
  assert.deepEqual(promoLines("CURRENT OFFERS\nSale\n"), [], "headings alone are not offers");
  assert.deepEqual(promoLines("aa bb cc dd ee ff\naa bb cc dd ee ff"), ["aa bb cc dd ee ff"]);
});
await test("a read counts only when the stop line was on the page — an outage never ends every offer", () => {
  assert.equal(hasStopLine(PAGE, "standard terms and conditions of sale"), true);
  assert.equal(hasStopLine("Our site is down for maintenance", "STANDARD TERMS AND CONDITIONS OF SALE"), false);
  assert.equal(hasStopLine(PAGE, ""), false);
  assert.equal(hasStopLine("STANDARD TERMS AND CONDITIONS OF SALE\nlegal…", "STANDARD TERMS AND CONDITIONS OF SALE"), true, "an empty offers section is still a real read");
});
await test("a read against the open lines: kept, started, ended — and a line with a typo fixed is an edit, not an end", () => {
  const open = ["20% off all boots with code FALL20 — ends 11/2.", "Free shiping on orders over $75 (lower 48 states).", "Buy an orthotic, get a free pair of socks."];
  const d = diffPromoLines(open, promoLines(cutPromoSection(PAGE.replace("20% off all boots with code FALL20 — ends 11/2.\n", ""), "STANDARD TERMS AND CONDITIONS OF SALE")));
  assert.deepEqual(d.ended, ["20% off all boots with code FALL20 — ends 11/2."]);
  assert.deepEqual(d.edited, [{ from: "Free shiping on orders over $75 (lower 48 states).", to: "Free shipping on orders over $75 (lower 48 states)." }]);
  assert.deepEqual(d.started, ["Spend $150, save $25."]);
  assert.deepEqual(d.kept, ["Buy an orthotic, get a free pair of socks."]);
  assert.ok(lineSimilarity("20% off boots", "20% off sandals") < 0.7, "a different offer is not an edit");
  assert.deepEqual(diffPromoLines([], []), { kept: [], started: [], ended: [], edited: [] });
});

console.log("\noffers: looking one up by the customer's words");
const rows = [
  { id: "a", source: "page", text: "20% off all boots with code FALL20 — ends 11/2.", firstSeenAt: at("2026-10-28T09:00:00-04:00"), lastSeenAt: at("2026-11-02T23:50:00-05:00"), endedAt: at("2026-11-03T00:05:00-05:00") },
  { id: "b", source: "page", text: "Free shipping on orders over $75 (lower 48 states).", firstSeenAt: at("2026-09-01T09:00:00-04:00"), lastSeenAt: at("2026-11-03T14:50:00-05:00"), endedAt: null },
  { id: "c", source: "campaign", text: "Labor Day Sale — 25% off sitewide with code LABOR25", firstSeenAt: at("2026-09-04T00:00:00-04:00"), lastSeenAt: at("2026-09-08T23:59:00-04:00"), endedAt: at("2026-09-08T23:59:00-04:00") },
  { id: "d", source: "page", text: "Buy an orthotic, get a free pair of socks.", firstSeenAt: at("2026-10-01T09:00:00-04:00"), lastSeenAt: at("2026-10-20T09:00:00-04:00"), endedAt: at("2026-10-21T09:00:00-04:00") },
];
await test("the words that matter: codes and amounts kept, filler dropped", () => {
  assert.deepEqual(offerWords("I got an email about 20% off boots with code FALL20, is it still on?"), ["20%", "boots", "fall20"]);
  assert.deepEqual(offerWords("the sale"), []);
});
await test("a match: the ended boots offer by its code or its words; the running one is reported running, never ended", () => {
  const m = matchOffers(rows, "code FALL20", { now: NOW.getTime(), days: 90 });
  assert.deepEqual(m.ended.map((r) => r.id), ["a"]);
  assert.deepEqual(m.running, []);
  const free = matchOffers(rows, "free shipping over $75", { now: NOW.getTime(), days: 90 });
  assert.deepEqual(free.running.map((r) => r.id), ["b"]);
  assert.deepEqual(matchOffers(rows, "LABOR25", { now: NOW.getTime(), days: 30 }).ended, [], "outside the memory window: no record");
  assert.deepEqual(matchOffers(rows, "LABOR25", { now: NOW.getTime(), days: 90 }).ended.map((r) => r.id), ["c"]);
  assert.deepEqual(matchOffers(rows, "hello there", { now: NOW.getTime() }).ended, []);
});
await test("the wording is only what the reads say: 'ended on' when the same day, else 'still on through… had ended by…', with days ago", () => {
  const a = endedWording(rows[0], { tz: MEMORY_TZ, now: NOW.getTime() });
  assert.equal(a.words, "was still on through Nov 2, 2026 and had ended by Nov 3, 2026 (today)");
  const sameDay = endedWording({ ...rows[0], lastSeenAt: at("2026-11-02T10:00:00-05:00"), endedAt: at("2026-11-02T10:20:00-05:00") }, { tz: MEMORY_TZ, now: NOW.getTime() });
  assert.equal(sameDay.words, "ended on Nov 2, 2026 (yesterday)");
  assert.equal(sameDay.daysAgo, 1);
  assert.equal(endedWording(rows[1], { tz: MEMORY_TZ }).status, "running");
  assert.equal(daysBetween(at("2026-11-02T23:30:00-05:00"), at("2026-11-03T00:30:00-05:00"), MEMORY_TZ), 1, "calendar days in the store's zone");
  assert.equal(daysBetween(at("2026-11-02T23:30:00-05:00"), at("2026-11-03T00:30:00-05:00"), "America/Los_Angeles"), 0);
});
await test("the tool's answer: ended with its wording; running → answer from the live list; nothing → say there's no record", () => {
  const ended = pastOffersResult(matchOffers(rows, "FALL20", { now: NOW.getTime() }), { tz: MEMORY_TZ, now: NOW.getTime(), days: 90 });
  assert.equal(ended.ended[0].offer, rows[0].text);
  assert.match(ended.ended[0].when, /had ended by Nov 3, 2026/);
  assert.match(ended.note, /Tell the customer the offer has ended, using "when" as given/);
  const running = pastOffersResult(matchOffers(rows, "free shipping", { now: NOW.getTime() }), { tz: MEMORY_TZ, now: NOW.getTime() });
  assert.match(running.note, /running now/);
  assert.equal(running.ended, undefined);
  const none = pastOffersResult(matchOffers(rows, "BOGO50 sandals", { now: NOW.getTime() }), { tz: MEMORY_TZ, now: NOW.getTime(), days: 90 });
  assert.match(none.note, /No remembered offer matches those words \(the store keeps ended offers for 90 days\)/);
  assert.match(none.note, /don't guess/);
});
await test("the tool itself reads the store's memory with the store's window and never Shopify's discounts", async () => {
  const seen = [];
  const t = pastOffersTool({ shop: "s", config: { promoMemoryDays: "60" }, listMemory: async (shop, o) => { seen.push([shop, o.days]); return rows; }, now: () => NOW.getTime() });
  assert.equal(t.definition, PAST_OFFERS_TOOL);
  assert.doesNotMatch(PAST_OFFERS_TOOL.description, /Shopify|discountNodes/);
  const r = await t.run({ query: "FALL20 boots" });
  assert.deepEqual(seen, [["s", 60]]);
  assert.equal(r.ended.length, 1);
  assert.equal(promoMemoryDays("abc"), 90); assert.equal(promoMemoryDays(180), 180);
  assert.equal(styleMemoryDays(99), 730); assert.equal(styleMemoryDays("365"), 365);
});

console.log("\nstyles: remembering what left the store");
const product = (title, status = "ACTIVE", extra = {}) => ({
  shopifyId: `gid://shopify/Product/${title.length}${title.charCodeAt(0)}`, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title, productType: "Footwear", status,
  featuredImageUrl: "https://img/x.jpg", attributesJson: { category_for_filter: "Sandals", gender: "women" }, tags: [], description: "", ...extra,
});
const live = buildLeanCatalog([
  { ...product("Savannah Adjustable Quarter Strap Sandal - Red"), variants: [{ price: "129.95", inventoryQty: 3, optionsJson: JSON.stringify([{ name: "Size", value: "8 US" }]) }] },
  { ...product("Maeve Casual Slip-On - Taupe"), variants: [{ price: "99.95", inventoryQty: 3, optionsJson: JSON.stringify([{ name: "Size", value: "8 US" }]) }] },
], { shop: "s.myshopify.com" });
const retired = [
  { ...retiredRowFromProduct(product("Blake Adjustable Sandal - Black", "ARCHIVED"), "archived"), retiredAt: at("2026-06-03T12:00:00-04:00"), returnedAt: null },
  { ...retiredRowFromProduct(product("Blake Adjustable Sandal - Tan", "ARCHIVED"), "archived"), retiredAt: at("2026-06-10T12:00:00-04:00"), returnedAt: null },
  { ...retiredRowFromProduct(product("Savannah Adjustable Quarter Strap Sandal - Navy", "ARCHIVED"), "archived"), retiredAt: at("2026-07-01T12:00:00-04:00"), returnedAt: null },
  { ...retiredRowFromProduct(product("Women's Comfort Clog - White", "DRAFT"), "draft"), retiredAt: at("2026-10-30T12:00:00-04:00"), returnedAt: null },
  { ...retiredRowFromProduct(product("Jillian Wedge - Black"), "deleted"), retiredAt: at("2026-01-10T12:00:00-05:00"), returnedAt: at("2026-02-01T12:00:00-05:00") },
];
await test("a retired row keeps what the chat needs: the style, kind, gender, picture and why", () => {
  const r = retiredRowFromProduct(product("Blake Adjustable Sandal - Black", "ARCHIVED"), "archived");
  assert.equal(r.style, "Blake Adjustable Sandal"); assert.equal(r.category, "Sandals"); assert.equal(r.gender, "women"); assert.equal(r.reason, "archived");
  assert.equal(retiredRowFromProduct(product("X - Y"), "nonsense").reason, "archived");
  assert.equal(titleColor("Blake Adjustable Sandal - Black"), "Black"); assert.equal(titleColor("Silicone Heel Cradles"), "");
  assert.equal(M.retireReason("ARCHIVED"), "archived"); assert.equal(M.retireReason("draft"), "draft"); assert.equal(M.retireReason("ACTIVE"), "");
});
await test("the index: Blake (two colorways) is retired; Savannah is still sold in red, so its navy is a colorway, not a goner; generic words never match; a style that came back is out", () => {
  const idx = retiredStyleIndex(retired, { liveKeys: liveStyleKeys(live), generic: GENERIC_STYLE_WORDS, vocab: new Set() });
  assert.deepEqual([...idx.keys()].sort(), ["blake"]);
  const blake = idx.get("blake");
  assert.equal(blake.styles.size, 1);
  const s = [...blake.styles.values()][0];
  assert.deepEqual(s.colors, ["Black", "Tan"]);
  assert.equal(s.retiredAt, retired[1].retiredAt, "the latest date of the style");
  assert.deepEqual(retiredStylesInText(idx, "do you still have the Blake's in black?").map((h) => h.name), ["Blake"]);
  assert.deepEqual(retiredStylesInText(idx, "savannah sandals?"), []);
  assert.deepEqual(retiredStylesInText(idx, "jillian wedge?"), []);
});
await test("the note under the message says discontinued with the date and colorways, and asks for the closest live styles — a draft says 'not sold right now'", () => {
  const idx = retiredStyleIndex(retired, { liveKeys: liveStyleKeys(live), generic: GENERIC_STYLE_WORDS, vocab: new Set() });
  const note = retiredNote(retiredStylesInText(idx, "the Blake"), { tz: MEMORY_TZ, now: NOW.getTime() });
  assert.match(note, /RETIRED STYLE — the store's own record/);
  assert.match(note, /"Blake Adjustable Sandal" \(women Sandals\) — discontinued; left the store on Jun 10, 2026 \(146 days ago\); it came in Black, Tan/);
  assert.match(note, /show the closest styles sold now/);
  assert.match(note, /never guess why/);
  const draftIdx = retiredStyleIndex(retired.filter((r) => r.reason === "draft"), { generic: GENERIC_STYLE_WORDS });
  assert.deepEqual([...draftIdx.keys()], ["comfort"].filter((k) => !GENERIC_STYLE_WORDS.has(k)), "Women's and Comfort are generic words — nothing to match");
  assert.equal(retiredNote([]), "");
});
await test("what counts as a memory claim in a reply", () => {
  assert.equal(claimsFromMemory("That offer ended on Sunday."), true);
  assert.equal(claimsFromMemory("The FALL20 code has expired."), true);
  assert.equal(claimsFromMemory("The Blake was discontinued last spring."), true);
  assert.equal(claimsFromMemory("We no longer carry the Blake."), true);
  assert.equal(claimsFromMemory("Free shipping is running until Sunday."), false);
  assert.equal(claimsFromMemory("Size 8 is sold out, but 8.5 is in stock."), false);
});

console.log("\nthe engine: the record, or no claim");
const tu = (id, name, input) => ({ type: "tool_use", id, name, input });
const txt = (text) => ({ type: "text", text });
function scripted(responses) {
  const requests = [];
  let i = 0;
  return { requests, callModel: async (req) => { requests.push(JSON.parse(JSON.stringify(req))); const r = responses[i++]; if (!r) throw new Error("script exhausted"); return { usage: { input_tokens: 10, output_tokens: 5 }, ...r }; } };
}
await test("a typed retired style gets the record under the message, and 'discontinued' stands", async () => {
  const s = scripted([{ stop_reason: "end_turn", content: [txt("The Blake was discontinued in June — it came in black and tan. Want me to show the closest sandals sold now?")] }]);
  const logs = [];
  const r = await runLeanTurn({ catalog: live, model: "m", messages: [{ role: "user", content: "Do you still have the Blake sandal?" }], latestUserMessage: "Do you still have the Blake sandal?", callModel: s.callModel, log: (l) => logs.push(l), retired, memoryTz: MEMORY_TZ });
  assert.equal(r.retried, false);
  assert.match(JSON.stringify(s.requests[0].messages.at(-1)), /RETIRED STYLE/);
  assert.ok(logs.some((l) => /retired styles typed: Blake/.test(l)), logs.join("\n"));
});
await test("'discontinued' with no record goes back once; the honest reply stands", async () => {
  const s = scripted([
    { stop_reason: "end_turn", content: [txt("The Jillian wedge was discontinued, sorry!")] },
    { stop_reason: "end_turn", content: [txt("I don't see a Jillian in the current line-up — it may be spelled differently. Want me to search by what you need?")] },
  ]);
  const logs = [];
  const r = await runLeanTurn({ catalog: live, model: "m", messages: [{ role: "user", content: "Do you still make the Jillian wedge?" }], latestUserMessage: "Do you still make the Jillian wedge?", callModel: s.callModel, log: (l) => logs.push(l), retired, memoryTz: MEMORY_TZ });
  assert.equal(r.retried, true);
  assert.ok(logs.some((l) => /rewrite: .*memory_unchecked/.test(l)), logs.join("\n"));
  assert.match(JSON.stringify(s.requests[1].messages.at(-1)), /nothing in this conversation records that/);
  assert.doesNotMatch(r.text, /discontinued/);
});
await test("'that offer ended' is fine once lookup_past_offers found it; a made-up 'expired' with no record goes back", async () => {
  const tool = { definition: PAST_OFFERS_TOOL, run: async () => pastOffersResult(matchOffers(rows, "FALL20", { now: NOW.getTime() }), { tz: MEMORY_TZ, now: NOW.getTime() }) };
  const ok = scripted([
    { stop_reason: "tool_use", content: [tu("t1", "lookup_past_offers", { query: "FALL20 boots" })] },
    { stop_reason: "end_turn", content: [txt("That 20% off boots offer (code FALL20) was still on through Nov 2 and has ended. Want to see what's on now?")] },
  ]);
  const r1 = await runLeanTurn({ catalog: live, model: "m", messages: [{ role: "user", content: "I got an email about 20% off boots with FALL20, still on?" }], latestUserMessage: "I got an email about 20% off boots with FALL20, still on?", callModel: ok.callModel, log: quiet, extraTools: [tool] });
  assert.equal(r1.retried, false);
  const bad = scripted([
    { stop_reason: "end_turn", content: [txt("Sorry, that code has expired.")] },
    { stop_reason: "end_turn", content: [txt("I don't have a record of that offer. What's running now: free shipping over $75.")] },
  ]);
  const logs = [];
  const r2 = await runLeanTurn({ catalog: live, model: "m", messages: [{ role: "user", content: "Is code SPRING10 still good?" }], latestUserMessage: "Is code SPRING10 still good?", callModel: bad.callModel, log: (l) => logs.push(l), extraTools: [tool] });
  assert.equal(r2.retried, true);
  assert.ok(logs.some((l) => /memory_unchecked/.test(l)));
  assert.match(JSON.stringify(bad.requests[1].messages.at(-1)), /lookup_past_offers/);
});
await test("the prompt tells the model the rules: look offers up, never guess an end, never call a style discontinued on its own", () => {
  const sys = buildLeanSystemPrompt({ config: {}, vocab: {}, shop: "s" });
  assert.match(sys, /lookup_past_offers/);
  assert.match(sys, /never say an offer ended on your own/);
  assert.match(sys, /never call a style discontinued on your own/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
