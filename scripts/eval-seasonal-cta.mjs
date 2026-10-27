// Seasonal button (Settings → Seasonal button): what the store saves, what
// the widget gets, the icons and colors the widget draws, and reading the
// collection's products from Shopify (cached, stale-while-reload).
//
// Run: node scripts/eval-seasonal-cta.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SEASONS, collectionHandle, cleanLabel, defaultLabel, tintOf, seasonalCtaConfig, seasonalCollection, seasonalForTurn,
  seasonalTapNote, SEASON_ICON_SVG, SEASON_ICON_COLORS, SEASON_TINTS, LABEL_MAX,
} from "../app/lib/seasonal-cta.js";
import { findCollection } from "../app/lib/seasonal-cta.server.js";
import { readCollection, collectionView, featuredCollection, forgetCollections } from "../app/lib/lean/collections.server.js";
import { buildLeanCatalog } from "../app/lib/lean/catalog.js";

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}
const widgetJs = readFileSync(new URL("../extensions/hajirai-chat-widget/assets/hajirai-chat-widget.js", import.meta.url), "utf8");
const widgetCss = readFileSync(new URL("../extensions/hajirai-chat-widget/assets/hajirai-chat-widget.css", import.meta.url), "utf8");
const settled = () => new Promise((r) => setImmediate(r));
const quiet = async (fn) => { const was = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = was; } };

console.log("\nsettings");
await test("a collection reads from its handle, its /collections/ path or the full store link", () => {
  assert.equal(collectionHandle("fall-collection"), "fall-collection");
  assert.equal(collectionHandle("  Fall-Collection "), "fall-collection");
  assert.equal(collectionHandle("/collections/fall-collection"), "fall-collection");
  assert.equal(collectionHandle("https://www.aetrex.com/collections/fall-collection?page=2#top"), "fall-collection");
  assert.equal(collectionHandle("https://aetrex.com/collections/women/products/danika"), "women");
  assert.equal(collectionHandle("all"), "", "the all-products list isn't a collection to feature");
  assert.equal(collectionHandle("/collections/all"), "");
  assert.equal(collectionHandle("fall collection"), "", "spaces never make a handle");
  assert.equal(collectionHandle(""), "");
  assert.equal(collectionHandle(null), "");
});
await test("the button's words: tidied, at most 40 characters, the season's name when empty", () => {
  assert.equal(cleanLabel("  Fall   Collection  Footwear ", "fall"), "Fall Collection Footwear");
  assert.equal(cleanLabel("", "winter"), "Winter Collection");
  assert.equal(cleanLabel("x".repeat(60), "fall").length, LABEL_MAX);
  assert.deepEqual(SEASONS.map(defaultLabel), ["Fall Collection", "Winter Collection", "Spring Collection", "Summer Collection"]);
  assert.equal(defaultLabel("bogus"), "Fall Collection");
});
await test("the color: auto takes the icon's season; a chosen one or plain wins; nonsense falls back", () => {
  assert.equal(tintOf("winter", "auto"), "winter");
  assert.equal(tintOf("winter", "summer"), "summer");
  assert.equal(tintOf("spring", "plain"), "plain");
  assert.equal(tintOf("summer", "neon"), "summer");
  assert.equal(tintOf("bogus", undefined), "fall");
});
await test("widget-config: on only when turned on and a collection is set", () => {
  const base = { seasonalCtaIcon: "fall", seasonalCtaColor: "auto", seasonalCtaLabel: "Fall Collection Footwear", seasonalCtaCollection: "fall-collection" };
  assert.deepEqual(seasonalCtaConfig({ ...base, seasonalCtaOn: true }), { on: true, icon: "fall", color: "fall", label: "Fall Collection Footwear" });
  assert.equal(seasonalCtaConfig({ ...base, seasonalCtaOn: false }).on, false);
  assert.equal(seasonalCtaConfig({ ...base, seasonalCtaOn: true, seasonalCtaCollection: "" }).on, false);
  assert.equal(seasonalCtaConfig({ ...base, seasonalCtaOn: "true" }).on, false, "only a real true turns it on");
  assert.deepEqual(seasonalCtaConfig({}), { on: false, icon: "fall", color: "fall", label: "Fall Collection" });
  assert.equal(JSON.stringify(seasonalCtaConfig({ ...base, seasonalCtaOn: true })).includes("fall-collection"), false, "the collection itself stays on the server");
});
await test("the chat's collection: null when off; the saved title, else the button's words", () => {
  const on = { seasonalCtaOn: true, seasonalCtaIcon: "fall", seasonalCtaLabel: "Fall Collection Footwear", seasonalCtaCollection: "/collections/fall-collection" };
  assert.deepEqual(seasonalCollection({ ...on, seasonalCtaCollectionTitle: "Fall Collection" }), { handle: "fall-collection", title: "Fall Collection", label: "Fall Collection Footwear" });
  assert.equal(seasonalCollection(on).title, "Fall Collection Footwear");
  assert.equal(seasonalCollection({ ...on, seasonalCtaOn: false }), null);
});
await test("the collection is for the reply to the tap only — every later message searches the whole store", () => {
  const on = { seasonalCtaOn: true, seasonalCtaIcon: "fall", seasonalCtaLabel: "New Arrivals", seasonalCtaCollection: "new-arrivals", seasonalCtaCollectionTitle: "New Arrivals" };
  assert.deepEqual(seasonalForTurn(on, { tapped: true }), { handle: "new-arrivals", title: "New Arrivals", label: "New Arrivals" });
  assert.equal(seasonalForTurn(on, { tapped: false }), null, "a follow-up (\"any men's styles?\") isn't tied to it");
  assert.equal(seasonalForTurn(on), null);
  assert.equal(seasonalForTurn({ ...on, seasonalCtaOn: false }, { tapped: true }), null, "off: never");
});
await test("the tap note asks for the collection's colorful footwear straight away, no question first", () => {
  const n = seasonalTapNote({ handle: "fall-collection", title: "Fall Collection", label: "Fall Collection Footwear" });
  assert.match(n, /collection "fall-collection"/);
  assert.match(n, /colorful: true/);
  assert.match(n, /"Fall Collection" collection/);
  assert.match(n, /Don't ask a question first/);
});

console.log("\nicons and colors");
await test("four season icons, the same 24-unit line style as the chat's other icons", () => {
  assert.deepEqual(Object.keys(SEASON_ICON_SVG), SEASONS);
  for (const [name, svg] of Object.entries(SEASON_ICON_SVG)) {
    assert.match(svg, new RegExp(`^<svg class="ai-sea-ic ai-sea-ic--${name}" viewBox="0 0 24 24" width="20" height="20" fill="none"`), name);
    assert.match(svg, /aria-hidden="true" focusable="false"/, name);
    assert.doesNotMatch(svg, /#[0-9a-f]{3,6}|rgb/i, `${name}: colors come from CSS, light and dark`);
    assert.match(svg, /<\/svg>$/, name);
  }
});
await test("the widget draws exactly the same icons as Settings shows", () => {
  for (const [name, svg] of Object.entries(SEASON_ICON_SVG)) {
    assert.ok(widgetJs.includes(`${name}:${JSON.stringify(svg)}`), `widget SEASON_ICONS.${name} differs from app/lib/seasonal-cta.js`);
  }
});
await test("the widget CSS uses the same icon colors, light and dark", () => {
  for (const [mode, seasons] of Object.entries(SEASON_ICON_COLORS)) {
    for (const [season, colors] of Object.entries(seasons)) {
      const sel = `${mode === "dark" ? '.ai-chat-panel[data-theme="dark"]' : ".ai-chat-panel"} .ai-sea-ic--${season} {`;
      const line = widgetCss.split("\n").find((l) => l.startsWith(sel));
      assert.ok(line, `no CSS rule ${sel}`);
      for (const [k, v] of Object.entries(colors)) assert.ok(line.includes(`--sx-${k}: ${v};`), `${mode} ${season} --sx-${k} should be ${v}`);
    }
  }
});
await test("the widget CSS uses the same tints (background, hover, ring, arrow), light and dark", () => {
  for (const [mode, tints] of Object.entries(SEASON_TINTS)) {
    const pre = mode === "dark" ? '.ai-chat-panel[data-theme="dark"]' : ".ai-chat-panel";
    for (const [season, t] of Object.entries(tints)) {
      const tile = widgetCss.split("\n").find((l) => l.startsWith(`${pre} .ai-chat-welcome__cta-btn.is-season.sea-${season} {`));
      assert.ok(tile, `no ${mode} tint for ${season}`);
      assert.ok(tile.includes(`--sea-bg: ${t.bg};`), `${mode} ${season} bg`);
      assert.ok(tile.includes(`--sea-bg-h: ${t.hover};`), `${mode} ${season} hover`);
      assert.ok(tile.includes(`--sea-ring: ${t.ring};`), `${mode} ${season} ring`);
      assert.ok(widgetCss.includes(`${pre} .ai-chat-welcome__cta-btn.is-season.sea-${season} .ai-chat-welcome__cta-go { color: ${t.go}; }`), `${mode} ${season} arrow`);
    }
  }
});
await test("the icon moves on hover only for shoppers who haven't asked for less motion", () => {
  const i = widgetCss.indexOf(".is-season:hover .ai-sea-ic--fall");
  assert.ok(i > 0);
  const before = widgetCss.slice(0, i);
  assert.ok(before.lastIndexOf("prefers-reduced-motion: no-preference") > before.lastIndexOf("}\n}"), "inside a no-preference block");
});

console.log("\nthe collection from Shopify");
// A stub Admin GraphQL: pages of 250 handles, then the next cursor.
function shopifyStub({ title = "Fall Collection", handles = [], missing = false, failWith = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { variables } = JSON.parse(init.body);
    calls.push({ url, variables, token: init.headers["X-Shopify-Access-Token"] });
    if (failWith) return failWith();
    if (missing) return { ok: true, json: async () => ({ data: { collectionByIdentifier: null } }) };
    const start = variables.cursor ? Number(variables.cursor) : 0;
    const page = handles.slice(start, start + 250);
    const next = start + 250 < handles.length;
    return { ok: true, json: async () => ({ data: { collectionByIdentifier: { title, products: { pageInfo: { hasNextPage: next, endCursor: next ? String(start + 250) : null }, nodes: page.map((handle) => ({ handle })) } } } }) };
  };
  return { calls, fetchImpl };
}
const many = Array.from({ length: 424 }, (_, i) => `shoe-${i}`);

await test("reads every page of the collection, in its own order", async () => {
  const s = shopifyStub({ handles: many });
  const r = await readCollection({ shop: "s.myshopify.com", accessToken: "tok", handle: "fall-collection", fetchImpl: s.fetchImpl });
  assert.equal(r.title, "Fall Collection");
  assert.deepEqual(r.handles, many);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].variables.cursor, "250");
  assert.match(s.calls[0].url, /^https:\/\/s\.myshopify\.com\/admin\/api\/[\d-]+\/graphql\.json$/);
  assert.equal(s.calls[0].token, "tok");
});
await test("no such collection → null; Shopify errors throw (the caller keeps what it had)", async () => {
  assert.equal(await readCollection({ shop: "s", accessToken: "t", handle: "x", fetchImpl: shopifyStub({ missing: true }).fetchImpl }), null);
  await assert.rejects(readCollection({ shop: "s", accessToken: "t", handle: "x", fetchImpl: shopifyStub({ failWith: () => ({ ok: false, status: 503 }) }).fetchImpl }), /503/);
  await assert.rejects(readCollection({ shop: "s", accessToken: "t", handle: "x", fetchImpl: shopifyStub({ failWith: () => ({ ok: true, json: async () => ({ errors: [{ message: "Throttled" }] }) }) }).fetchImpl }), /Throttled/);
});
await test("kept 10 minutes; then served stale while a fresh copy loads", async () => {
  forgetCollections();
  const s = shopifyStub({ handles: ["a", "b"] });
  const args = { shop: "s.myshopify.com", accessToken: "t", handle: "fall-collection", fetchImpl: s.fetchImpl };
  assert.deepEqual((await featuredCollection(args)).handles, ["a", "b"]);
  await featuredCollection(args);
  await featuredCollection({ ...args, now: Date.now() + 9 * 60 * 1000 });
  assert.equal(s.calls.length, 1, "one read in the first 10 minutes");
  const stale = await featuredCollection({ ...args, now: Date.now() + 11 * 60 * 1000 });
  assert.deepEqual(stale.handles, ["a", "b"], "the old copy is served at once");
  await settled();
  assert.equal(s.calls.length, 2, "and a fresh one is read in the background");
});
await test("a failed refresh keeps the last good copy; a first failure means none, retried after a minute", async () => {
  forgetCollections();
  let down = false;
  const good = shopifyStub({ handles: ["a"] });
  const fetchImpl = (u, i) => (down ? Promise.reject(new Error("network down")) : good.fetchImpl(u, i));
  const args = { shop: "s.myshopify.com", accessToken: "t", handle: "fall-collection", fetchImpl };
  await featuredCollection(args);
  down = true;
  await quiet(async () => {
    await featuredCollection({ ...args, now: Date.now() + 11 * 60 * 1000 });
    await settled(); await settled();
  });
  assert.deepEqual((await featuredCollection(args)).handles, ["a"], "still the last good copy");

  forgetCollections();
  let calls = 0;
  const failing = { ...args, handle: "winter", fetchImpl: () => { calls++; return Promise.reject(new Error("down")); } };
  assert.equal(await quiet(() => featuredCollection(failing)), null);
  assert.equal(await featuredCollection(failing), null);
  assert.equal(calls, 1, "not read again on every chat");
  await quiet(async () => { await featuredCollection({ ...failing, now: Date.now() + 61 * 1000 }); await settled(); });
  assert.equal(calls, 2, "tried again after a minute");
});
await test("nothing is read without a shop, a token or a collection", async () => {
  const s = shopifyStub({ handles: ["a"] });
  assert.equal(await featuredCollection({ shop: "", accessToken: "t", handle: "x", fetchImpl: s.fetchImpl }), null);
  assert.equal(await featuredCollection({ shop: "s", accessToken: "", handle: "x", fetchImpl: s.fetchImpl }), null);
  assert.equal(await featuredCollection({ shop: "s", accessToken: "t", handle: "", fetchImpl: s.fetchImpl }), null);
  assert.equal(s.calls.length, 0);
});
await test("the search keeps to the collection's footwear — unless it has no footwear", () => {
  const row = (title, type) => ({ handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title, productType: type, tags: [], description: "", status: "ACTIVE", attributesJson: {}, variants: [{ price: "99.95", inventoryQty: 2, optionsJson: "[]" }] });
  const cat = buildLeanCatalog([row("Danika Sneaker - Pink", "Footwear"), row("Fall Socks", "Accessories"), row("Train Orthotic", "Orthotics")], { shop: "s" });
  const mixed = collectionView({ title: "Fall Collection", handles: ["fall-socks", "danika-sneaker-pink"] }, cat);
  assert.equal(mixed.title, "Fall Collection");
  assert.equal(mixed.footwearOnly, true);
  assert.equal(mixed.order.get("danika-sneaker-pink"), 1);
  assert.equal(collectionView({ title: "Gifts", handles: ["fall-socks", "train-orthotic"] }, cat).footwearOnly, false);
  assert.equal(collectionView(null, cat), null);
});
await test("Settings checks the collection exists (title and product count)", async () => {
  const admin = (data, errors) => ({ graphql: async (q, { variables }) => ({ json: async () => ({ ...(errors ? { errors } : {}), data: typeof data === "function" ? data(variables) : data }) }) });
  const found = await findCollection(admin(({ handle }) => ({ collectionByIdentifier: { handle, title: "Fall Collection", productsCount: { count: 424 } } })), "https://aetrex.com/collections/fall-collection");
  assert.deepEqual(found, { handle: "fall-collection", title: "Fall Collection", count: 424 });
  assert.equal(await findCollection(admin({ collectionByIdentifier: null }), "nope"), null);
  assert.equal(await findCollection(admin({}), "not a handle!"), null);
  await assert.rejects(findCollection(admin(null, [{ message: "Access denied" }]), "fall-collection"), /Access denied/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
