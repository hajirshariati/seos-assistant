// End-to-end server test: the production build, a real Postgres, signed
// Shopify app-proxy requests — and a stand-in Anthropic API that answers the
// way Claude does (search → show → reply), so the whole storefront path runs
// without spending money. Also a load test of that path.
//
// Needs: `npm run build` first, and TEST_DATABASE_URL pointing at a migrated
// database (pgvector). Writes a JSON result to stdout's last line.
//
// Run: TEST_DATABASE_URL=postgresql://... node scripts/e2e/server-integration.mjs [--load=50]

import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.log("skipped: set TEST_DATABASE_URL"); process.exit(0); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOAD = Number((process.argv.find((a) => a.startsWith("--load=")) || "--load=50").split("=")[1]);
const SECRET = "integration-secret";
const ENCRYPTION_KEY = "1".repeat(64);
const SHOP = `integration-${Date.now()}.myshopify.com`;
const BUSY_SHOP = `integration-busy-${Date.now()}.myshopify.com`;
const PAGE_VIEWS = Number((process.argv.find((a) => a.startsWith("--pageviews=")) || "--pageviews=2000").split("=")[1]);
const APP_PORT = 3990 + Math.floor(Math.random() * 9);
const MODEL_PORT = APP_PORT + 100;
const EVENTS_PORT = APP_PORT + 200;
const MODEL_DELAY_MS = 400; // per model call — a fast real Claude step is ~1-3s

process.env.DATABASE_URL = DB;
process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
const { default: prisma } = await import(path.join(ROOT, "app/db.server.js"));
const { encrypt } = await import(path.join(ROOT, "app/utils/encryption.server.js"));

// ── seed: an installed store with a 1,500-product catalog ──
const COLORS = ["Black", "Red", "Navy", "White", "Taupe"];
const CATS = ["Sandals", "Sneakers", "Boots", "Wedges/Heels", "Loafers"];
async function seed() {
  await prisma.session.create({ data: { id: `offline_${SHOP}`, shop: SHOP, state: "x", isOnline: false, accessToken: "shpat_test", scope: "read_products" } });
  // No store-wide limit here: the load test sends far more than a store would.
  await prisma.shopConfig.create({ data: {
    shop: SHOP, anthropicApiKey: encrypt("sk-ant-test"), anthropicModel: "claude-sonnet-4-20250514", chatLimitPerMin: 0, chatLimitPerHour: 0,
    // What AVA's Shopify Analytics events need from Shopify, as if already read.
    appEventsShop: JSON.stringify({ id: "gid://shopify/Shop/777", handle: "hajirai", title: "AVA Aetrex Virtual Assistant", currency: "USD", at: Date.now() }),
  } });
  // A second store with a tiny limit, for the busy-store checks.
  await prisma.session.create({ data: { id: `offline_${BUSY_SHOP}`, shop: BUSY_SHOP, state: "x", isOnline: false, accessToken: "shpat_test", scope: "read_products" } });
  await prisma.shopConfig.create({ data: { shop: BUSY_SHOP, anthropicApiKey: encrypt("sk-ant-test"), chatLimitPerMin: 2, chatLimitPerHour: 100, peakLimitPerMin: 10, appEventsEnabled: false } });
  const rows = [];
  for (let i = 0; i < 300; i++) {
    for (const color of COLORS) {
      const cat = CATS[i % CATS.length];
      const title = `Style${i} ${cat.split("/")[0].replace(/s$/, "")} - ${color}`;
      rows.push({
        shop: SHOP, shopifyId: `gid://shopify/Product/${i}${COLORS.indexOf(color)}`, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        title, productType: "Footwear", tags: [], description: "Arch support all day.", status: "ACTIVE", featuredImageUrl: "https://cdn.example/x.jpg",
        attributesJson: { category_for_filter: cat, gender: "women", color },
      });
    }
  }
  await prisma.product.createMany({ data: rows });
  const products = await prisma.product.findMany({ where: { shop: SHOP }, select: { id: true } });
  await prisma.productVariant.createMany({
    data: products.flatMap((p) => ["7 US", "8 US", "9 US"].map((s, k) => ({
      productId: p.id, shopifyId: `${p.id}-${k}`, price: "119.95", inventoryQty: 4, optionsJson: JSON.stringify([{ name: "Size", value: s }]),
    }))),
  });
  return rows.length;
}

// ── stand-in Anthropic API ──
const modelCalls = [];
function modelServer() {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const r = JSON.parse(body || "{}");
      const msgs = r.messages || [];
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      modelCalls.push({
        model: r.model, at: Date.now(), last: typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content || ""),
        searchProps: Object.keys(r.tools?.find((t) => t.name === "search_products")?.input_schema?.properties || {}),
        system: (Array.isArray(r.system) ? r.system.map((b) => b.text || "").join("\n") : String(r.system || "")),
      });
      const first = msgs.find((m) => m.role === "user");
      const firstText = typeof first?.content === "string" ? first.content : JSON.stringify(first?.content || "");
      const delay = /SLOW/.test(firstText) ? 6000 : MODEL_DELAY_MS;
      await new Promise((ok) => setTimeout(ok, delay));
      if (res.destroyed) return;
      if (/FAIL/.test(firstText)) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream test failure" } }));
      }
      const last = msgs[msgs.length - 1];
      const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === "tool_result") : [];
      const prevAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
      const prevTool = Array.isArray(prevAssistant?.content) ? prevAssistant.content.find((b) => b.type === "tool_use") : null;
      let content;
      let stop = "tool_use";
      if (!results.length) {
        content = [{ type: "tool_use", id: `tu_${Date.now()}`, name: "search_products", input: { query: "sandal", categories: ["sandals"] } }];
      } else if (prevTool?.name === "search_products") {
        const found = JSON.parse(results[0].content);
        const handles = (found.products || []).slice(0, 2).map((p) => p.handle);
        content = [{ type: "tool_use", id: `tu_${Date.now()}`, name: "show_products", input: { handles } }];
      } else {
        content = [{ type: "text", text: "Here are two supportive sandals I'd start with." }];
        stop = "end_turn";
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: r.model, content, stop_reason: stop, usage: { input_tokens: 4000, output_tokens: 80, cache_read_input_tokens: 3000 } }));
    });
  }).listen(MODEL_PORT);
}

// ── stand-in Shopify App Events API (token + events) ──
const appEvents = [];
const tokenRequests = [];
function appEventsServer() {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      if (req.url === "/auth/access_token") {
        tokenRequests.push(json);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ access_token: "app-events-token", token_type: "Bearer" }));
      }
      appEvents.push({ ...json, auth: req.headers.authorization, ua: req.headers["user-agent"] });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
  }).listen(EVENTS_PORT);
}

// ── signed app-proxy requests ──
function signed(pathname, extra = {}, shop = SHOP) {
  const p = new URLSearchParams({ shop, logged_in_customer_id: "", path_prefix: "/apps/hajirai", timestamp: String(Math.floor(Date.now() / 1000)), ...extra });
  const msg = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("");
  p.set("signature", crypto.createHmac("sha256", SECRET).update(msg).digest("hex"));
  return `http://localhost:${APP_PORT}${pathname}?${p}`;
}
async function chat(message, { ip = "198.51.100.1", history = [], signal, extra = {}, shop = SHOP } = {}) {
  const t0 = Date.now();
  const res = await fetch(signed("/chat", {}, shop), {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ message, history, ...extra }), signal,
  });
  if (!res.headers.get("content-type")?.includes("event-stream")) return { status: res.status, body: await res.json().catch(() => null), ms: Date.now() - t0 };
  const raw = await res.text();
  const events = raw.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
  return { status: res.status, events, ms: Date.now() - t0 };
}

let passed = 0;
let failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; results.push({ name, ok: false, error: err.message }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}
const healthRows = () => prisma.chatHealthEvent.findMany({ where: { shop: SHOP }, orderBy: { createdAt: "asc" } });
// The server keeps each store's settings for SHOP_CONFIG_CACHE_MS.
const configCacheExpiry = () => new Promise((r) => setTimeout(r, 1100));

const productCount = await seed();
const mock = modelServer();
const eventsMock = appEventsServer();
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env, NODE_ENV: "production", PORT: String(APP_PORT), DATABASE_URL: DB, ENCRYPTION_KEY,
    SHOPIFY_API_KEY: "integration-key", SHOPIFY_API_SECRET: SECRET, SHOPIFY_APP_URL: `http://localhost:${APP_PORT}`, SCOPES: "read_products",
    ANTHROPIC_BASE_URL: `http://localhost:${MODEL_PORT}`, DISABLE_CATALOG_SYNC_SCHEDULER: "true",
    APP_EVENTS_TOKEN_URL: `http://localhost:${EVENTS_PORT}/auth/access_token`, APP_EVENTS_URL: `http://localhost:${EVENTS_PORT}/app/2026-10/events`,
    // Settings changes made straight in the database show within a second.
    SHOP_CONFIG_CACHE_MS: "1000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://localhost:${APP_PORT}/healthz`)).ok) break; } catch { /* booting */ }
  await new Promise((r) => setTimeout(r, 500));
}

console.log("\nadmin behind an HTTPS proxy (Railway)");
await test("admin form posts forwarded as plain HTTP pass the cross-site check; other origins don't", async () => {
  const post = (origin) => fetch(`http://localhost:${APP_PORT}/app/knowledge.data`, {
    method: "POST", body: "intent=sync_store_knowledge",
    headers: { origin, "x-forwarded-proto": "https", "content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0 Chrome/130" },
    redirect: "manual",
  });
  const own = await post(`https://localhost:${APP_PORT}`);
  assert.notEqual(own.status, 400, "the admin's own submit was rejected as cross-site");
  assert.equal((await post("https://evil.example")).status, 400);
});

console.log(`\nstorefront path (production build, ${productCount} products, stand-in model)`);
await test("a signed chat turn streams the reply, two product cards and done", async () => {
  const r = await chat("i need supportive sandals");
  assert.equal(r.status, 200);
  const types = r.events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 2), ["text", "products"]);
  assert.equal(types.at(-1), "done");
  assert.match(r.events[0].text, /supportive sandals/);
  assert.equal(r.events[1].products.length, 2);
  assert.ok(r.events[1].products.every((p) => /sandal/i.test(p.title) && p.price_formatted === "$119.95"));
  assert.ok(modelCalls.at(-1).model === "claude-sonnet-4-6", "a deprecated stored model is never sent to Anthropic");
});
await test("the turn is recorded as healthy with its latency", async () => {
  await new Promise((r) => setTimeout(r, 200));
  const rows = await healthRows();
  assert.equal(rows.at(-1).ok, true);
  assert.ok(rows.at(-1).latencyMs >= MODEL_DELAY_MS * 3);
});
await test("an unsigned or tampered request is rejected", async () => {
  const tampered = signed("/chat").replace(SHOP, "other-store.myshopify.com");
  const a = await fetch(tampered, { method: "POST", body: "{}" });
  const b = await fetch(`http://localhost:${APP_PORT}/chat?shop=${SHOP}`, { method: "POST", body: "{}" });
  assert.ok(a.status >= 400 && a.status < 500, `tampered → ${a.status}`);
  assert.ok(b.status >= 400 && b.status < 500, `unsigned → ${b.status}`);
});
await test("an oversized request is refused before any model call", async () => {
  const before = modelCalls.length;
  const r = await chat("hi", { history: [{ role: "user", content: "x".repeat(120000) }], ip: "198.51.100.2" });
  assert.equal(r.status, 413);
  assert.equal(modelCalls.length, before);
});
await test("a provider failure becomes a friendly error event, recorded as 'upstream'", async () => {
  const r = await chat("FAIL please", { ip: "198.51.100.3" });
  const err = r.events.find((e) => e.type === "error");
  assert.ok(err, "error event sent");
  assert.doesNotMatch(err.message, /upstream test failure|500|api_error/i, "no internals shown to the shopper");
  await new Promise((r2) => setTimeout(r2, 200));
  assert.equal((await healthRows()).at(-1).errorKind, "upstream");
});
await test("when the shopper leaves mid-turn, no further model calls are made", async () => {
  const ctrl = new AbortController();
  const p = chat("SLOW sandals", { ip: "198.51.100.4", signal: ctrl.signal }).catch(() => null);
  await new Promise((r) => setTimeout(r, 1000));
  const callsAtAbort = modelCalls.length;
  ctrl.abort();
  await p;
  await new Promise((r) => setTimeout(r, 7000));
  assert.ok(modelCalls.length <= callsAtAbort, `calls after leaving: ${modelCalls.length - callsAtAbort}`);
  assert.equal((await healthRows()).at(-1).errorKind, "client_left");
});
await test("a shopper sending too fast is rate-limited (20/min)", async () => {
  const statuses = [];
  for (let i = 0; i < 22; i++) {
    const res = await fetch(signed("/chat"), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.77" }, body: "{}" });
    statuses.push(res.status);
  }
  assert.ok(statuses.slice(0, 20).every((s) => s === 400), "first 20 reach validation");
  assert.equal(statuses[20], 429);
});
await test("widget-config, feedback and See It Styled answer signed requests correctly", async () => {
  const cfg = await (await fetch(signed("/widget-config", { cta: "What can I help you find today?" }))).json();
  assert.equal(cfg.showFeedback, true);
  assert.ok(Array.isArray(cfg.hideOnUrls));
  assert.deepEqual(cfg.fitLevels, ["high", "mid"], "fit confidence: High and Mid on cards unless the store says");
  const fb = await fetch(signed("/feedback"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vote: "up", session: "s", botResponse: "ok" }) });
  assert.equal(fb.status, 200);
  const viz = await fetch(signed("/visualize"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productHandle: "x" }) });
  assert.equal(viz.status, 403, "feature off for this store → refused, no image call");
});

await test("View all pages: the reply sends page 1 and its search; the endpoint serves the rest, same order", async () => {
  const r = await chat("i need supportive sandals", { ip: "198.51.100.60" });
  const va = r.events.find((e) => e.type === "view_all");
  assert.ok(va, "a view_all event");
  assert.equal(va.pageSize, 24);
  assert.equal(va.products.length, 24);
  assert.ok(va.total > 48, `total ${va.total}`);
  assert.deepEqual(va.search, { query: "sandal", categories: ["sandals"] });
  const get = (page, search = va.search) => fetch(signed("/view-all", { search: JSON.stringify(search), page: String(page) }));
  const p1 = await (await get(1)).json();
  assert.deepEqual(p1.products.map((c) => c.handle), va.products.map((c) => c.handle), "page 1 matches the reply");
  const p2 = await (await get(2)).json();
  assert.equal(p2.ok, true);
  assert.equal(p2.page, 2);
  assert.equal(p2.total, va.total);
  assert.equal(p2.pages, Math.ceil(va.total / 24));
  assert.equal(p2.products.length, 24);
  assert.ok(p2.products.every((c) => /sandal/i.test(c.title) && c.price_formatted === "$119.95" && c.url && c.image));
  assert.equal(new Set([...p1.products, ...p2.products].map((c) => c.handle)).size, 48, "no repeats across pages");
  const last = await (await get(999)).json();
  assert.equal(last.page, p2.pages, "past the end → the last page");
  assert.equal((await get(2, { evil: "x" })).status, 400, "a search with nothing usable is refused");
  const unsigned = await fetch(`http://localhost:${APP_PORT}/view-all?shop=${SHOP}&search=%7B%7D&page=2`);
  assert.ok(unsigned.status >= 400 && unsigned.status < 500, `unsigned → ${unsigned.status}`);

  // The sheet's filters: every match indexed, in the same order as the pages…
  const ix = await (await fetch(signed("/view-all", { search: JSON.stringify(va.search), index: "1" }))).json();
  assert.equal(ix.ok, true);
  assert.equal(ix.total, va.total);
  assert.deepEqual(ix.items.slice(0, 48).map((i) => i.h), [...p1.products, ...p2.products].map((c) => c.handle), "index order = page order");
  assert.ok(ix.items.every((i) => typeof i.p === "number"), "every match has its price");
  assert.ok(ix.facets && Array.isArray(ix.facets.size.values), "facets come with it");
  // …and cards by handle, for what a filter brings up.
  const pick = [ix.items[60].h, ix.items[5].h, "no-such-product"];
  const cards = await (await fetch(signed("/view-all", { handles: pick.join(",") }))).json();
  assert.deepEqual(cards.products.map((c) => c.handle), pick.slice(0, 2), "asked order; unknown left out");
  assert.ok(cards.products.every((c) => c.title && c.url && c.price_formatted));
  assert.equal((await fetch(signed("/view-all", { handles: "<script>" }))).status, 400, "nothing usable → refused");
});
await test("product specs: a stored sheet reaches the catalog — spec filters find only what's listed, the tool offers them, the prompt has the rules", async () => {
  const SPEC = `integration-specs-${Date.now()}.myshopify.com`;
  await prisma.session.create({ data: { id: `offline_${SPEC}`, shop: SPEC, state: "x", isOnline: false, accessToken: "shpat_test", scope: "read_products" } });
  await prisma.shopConfig.create({ data: { shop: SPEC, anthropicApiKey: encrypt("sk-ant-test"), chatLimitPerMin: 0, chatLimitPerHour: 0 } });
  const add = async (handle, title, comfort) => {
    const p = await prisma.product.create({ data: { shop: SPEC, shopifyId: `gid://shopify/Product/${handle}`, handle, title, productType: "Footwear", tags: [], status: "ACTIVE", description: "Arch support.", attributesJson: { category_for_filter: "Sandals", comfort } } });
    await prisma.productVariant.create({ data: { productId: p.id, shopifyId: `${p.id}-v`, price: "120.00", inventoryQty: 3, optionsJson: JSON.stringify([{ name: "Size", value: "8 US" }]) } });
  };
  await add("danika-black-ap100w", "Danika Arch Support Sandal - Black", "Removable Insole: Yes");
  await add("jess-black-se210w", "Jess Sandal - Black", "Removable Insole: No");
  await add("athena-black-ct850w", "Athena Sandal - Black", "Adjustability: Laces");
  const { readSpecSheet } = await import(path.join(ROOT, "app/lib/product-specs.js"));
  const sheet = readSpecSheet([{ name: "AP", rows: [["Style #", "Style Name", "Removable Depth", "Contains Pig Products", "Shank"], ["AP100", "Danika", '5/16"', "No", "None"], ["SE210", "Jess", "None", "Yes", "Metal"]] }]);
  await prisma.productSpecSheet.create({ data: { shop: SPEC, fileName: "wiki.xlsx", rowsJson: JSON.stringify(sheet.rows), reportJson: JSON.stringify(sheet.report) } });
  const list = async (search) => {
    const res = await fetch(signed("/view-all", { search: JSON.stringify(search), page: "1" }, SPEC));
    assert.equal(res.status, 200);
    return (await res.json()).products.map((c) => c.handle).sort();
  };
  assert.deepEqual(await list({ query: "", categories: ["sandals"] }), ["athena-black-ct850w", "danika-black-ap100w", "jess-black-se210w"]);
  assert.deepEqual(await list({ query: "", removable_footbed: true }), ["danika-black-ap100w"], "only the one whose footbed comes out");
  assert.deepEqual(await list({ query: "", no_pig_products: true }), ["danika-black-ap100w"], "Jess lists pig products; Athena lists nothing");
  const before = modelCalls.length;
  const r = await chat("shoes for my custom orthotics", { ip: "198.51.100.61", shop: SPEC });
  assert.equal(r.status, 200);
  const call = modelCalls.slice(before).find((c) => c.searchProps.length);
  assert.ok(call.searchProps.includes("removable_footbed") && call.searchProps.includes("no_pig_products"), call.searchProps.join(","));
  assert.ok(!call.searchProps.includes("slip_resistant"), "no product lists it → not offered");
  assert.match(call.system, /never call a product halal, kosher or vegan/);
  await prisma.productSpecSheet.deleteMany({ where: { shop: SPEC } });
  for (const m of ["chatHealthEvent", "chatUsage", "chatTopic", "chatProductMention", "shopConfig", "session"]) await prisma[m].deleteMany({ where: { shop: SPEC } });
  await prisma.product.deleteMany({ where: { shop: SPEC } });
});
await test("\"Find my shoe size\" with no shoe picked: how True Fit works and the store's kinds of shoes, from the catalog — no model call", async () => {
  const tf = { provider: "truefit", page_handle: "" };
  const before = modelCalls.length;
  const r = await chat("Help me find my shoe size with True Fit.", { ip: "198.51.100.61", extra: { size_intro: true, size_finder: tf } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.events.map((e) => e.type), ["text", "products", "size_intro", "done"]);
  assert.match(r.events[0].text, /True Fit sizes one shoe at a time, so pick the shoe first/);
  const intro = r.events[2];
  assert.equal(intro.line, "women");
  assert.deepEqual(intro.lines.map((l) => l.k), ["women"]);
  assert.deepEqual(intro.lines[0].tiles.map((t) => `${t.l}:${t.n}`), ["Boots:60", "Loafers:60", "Sandals:60", "Sneakers:60", "Wedges/Heels:60"], "styles counted once across colors");
  assert.ok(intro.lines[0].tiles.every((t) => t.img === "https://cdn.example/x.jpg"));
  assert.equal(modelCalls.length, before, "answered without the model");
  // A style tile from it goes to the assistant, told what it's for.
  await chat("Show me women's sandals", { ip: "198.51.100.61", extra: { size_pick: true, size_finder: tf } });
  assert.ok(modelCalls.length > before);
  assert.match(modelCalls[before].last, /tap the True Fit button on the shoe they like/);
  // Without True Fit on the store, the same words go to the assistant as usual.
  const plain = await chat("Help me find my shoe size with True Fit.", { ip: "198.51.100.61", extra: { size_intro: true } });
  assert.ok(!plain.events.some((e) => e.type === "size_intro"));
  assert.match(plain.events[0].text, /sandals/);
});
await test("order status without signing in: signed requests only, JSON only, malformed refused, tries limited, the store's switch obeyed", async () => {
  const post = (body, { ip = "198.51.100.70", type = "application/json", url = signed("/order-lookup") } = {}) =>
    fetch(url, { method: "POST", headers: { "content-type": type, "x-forwarded-for": ip }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const unsigned = await post({ order: "1001", email: "a@b.co" }, { url: `http://localhost:${APP_PORT}/order-lookup?shop=${SHOP}` });
  assert.ok(unsigned.status >= 400 && unsigned.status < 500, `unsigned → ${unsigned.status}`);
  assert.equal((await post("order=1001&email=a@b.co", { type: "application/x-www-form-urlencoded" })).status, 415, "a plain form post from another page is refused");
  const bad = await post({ order: '1" OR email:*', email: "nope" });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys((await bad.json()).fields).sort(), ["email", "order"]);
  assert.equal(bad.headers.get("cache-control"), "no-store");
  // Every try counts (six per device in ten minutes), even malformed ones.
  for (let i = 0; i < 5; i++) await post({ order: "x", email: "x" });
  const limited = await post({ order: "x", email: "x" });
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).message, /Too many tries/);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  // The store turned it off: refused before anything is looked up.
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { guestOrderLookup: false } });
  await configCacheExpiry();
  const off = await post({ order: "1001", email: "a@b.co" }, { ip: "198.51.100.71" });
  assert.equal(off.status, 403);
  assert.equal((await off.json()).error, "off");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { guestOrderLookup: true } });
  await configCacheExpiry();
});
await test("Buy now: widget-config says off until the store turns it on; then on, with its code", async () => {
  const off = (await (await fetch(signed("/widget-config"))).json()).buyNow;
  assert.deepEqual(off, { on: false, code: "" }, "off by default, no code sent");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { buyNowCode: "CHAT10" } });
  await configCacheExpiry();
  assert.deepEqual((await (await fetch(signed("/widget-config"))).json()).buyNow, { on: false, code: "" }, "a code alone doesn't turn it on, or travel");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { buyNowEnabled: true } });
  await configCacheExpiry();
  assert.deepEqual((await (await fetch(signed("/widget-config"))).json()).buyNow, { on: true, code: "CHAT10" });
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { buyNowEnabled: false, buyNowCode: "" } });
  await configCacheExpiry();
});
// Events go out in the background: wait (up to 5s) until this many have come.
const eventsFrom = async (from, count) => {
  for (let i = 0; i < 50 && appEvents.length - from < count; i++) await new Promise((r) => setTimeout(r, 100));
  return appEvents.slice(from);
};
await test("Shopify Analytics: a first message is an AVA chat started, each card an AVA product shown — the app's own events, nothing personal", async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400));
  const from = appEvents.length;
  const r = await chat("i need supportive sandals", { ip: "198.51.100.70", extra: { session_id: "sess-ae-1", typed: true } });
  await eventsFrom(from, 3);
  await settle();
  const sent = appEvents.slice(from);
  const started = sent.filter((e) => e.event_handle === "hajirai.ava_chat_started");
  const shown = sent.filter((e) => e.event_handle === "hajirai.ava_product_shown");
  assert.equal(started.length, 1, `chat started: ${started.length}`);
  assert.deepEqual(started[0].attributes, { started_by: "typed", signed_in: false });
  const cards = r.events.find((e) => e.type === "products").products;
  assert.deepEqual(shown.map((e) => e.attributes.product_handle), cards.map((c) => c.handle), "one per card, in order");
  assert.deepEqual(shown.map((e) => e.attributes.position), [1, 2]);
  const ids = await prisma.product.findMany({ where: { shop: SHOP, handle: { in: cards.map((c) => c.handle) } }, select: { handle: true, shopifyId: true } });
  // The product's own Shopify ID (a made-up "00" in this test catalog is left out, not sent as 0).
  for (const e of shown) {
    const gid = ids.find((x) => x.handle === e.attributes.product_handle).shopifyId;
    const n = Number(gid.split("/").pop());
    assert.equal(e.attributes.product_id, n > 0 ? n : undefined, `${gid} → ${e.attributes.product_id}`);
  }
  for (const e of [...started, ...shown]) {
    assert.equal(e.shop_id, "gid://shopify/Shop/777");
    assert.equal(e.auth, "Bearer app-events-token");
    assert.ok(e.ua, "a User-Agent");
    assert.ok(e.idempotency_key.length <= 64 && /^ava_/.test(e.idempotency_key), e.idempotency_key);
    assert.ok(Math.abs(Date.parse(e.timestamp) - Date.now()) < 60_000);
    assert.doesNotMatch(JSON.stringify(e.attributes), /sess-ae-1|sandals|198\.51/, "no session, message or address");
  }
  assert.equal(new Set(shown.map((e) => e.idempotency_key)).size, shown.length, "each card its own key");
  assert.deepEqual(tokenRequests.at(-1), { client_id: "integration-key", client_secret: SECRET, grant_type: "client_credentials" }, "the app's own credentials");
  // A follow-up in the same chat isn't a new chat.
  const before = appEvents.length;
  await chat("any in black?", { ip: "198.51.100.70", history: [{ role: "user", content: "i need supportive sandals" }, { role: "assistant", content: "Here are two." }], extra: { session_id: "sess-ae-1", typed: true } });
  await eventsFrom(before, 2);
  await settle();
  assert.equal(appEvents.slice(before).filter((e) => e.event_handle === "hajirai.ava_chat_started").length, 0, "follow-up → no chat started");
  assert.ok(appEvents.slice(before).some((e) => e.event_handle === "hajirai.ava_product_shown"), "its cards still count");
});
await test("Shopify Analytics: adds to cart and checkouts from the chat, priced from the catalog; bad requests refused; off → nothing sent", async () => {
  const settle = () => new Promise((r) => setTimeout(r, 400));
  const p = await prisma.product.create({ data: { shop: SHOP, shopifyId: "gid://shopify/Product/9001", handle: "ae-test-sneaker", title: "AE Test Sneaker", status: "ACTIVE", tags: [] } });
  await prisma.productVariant.create({ data: { productId: p.id, shopifyId: "gid://shopify/ProductVariant/424242", price: "129.95", inventoryQty: 3 } });
  const post = (body, ip = "198.51.100.71") => fetch(signed("/activity"), { method: "POST", headers: { "content-type": "text/plain", "x-forwarded-for": ip }, body: JSON.stringify(body) });
  const from = appEvents.length;
  const add = await post({ kind: "add_to_cart", variant: "424242", quantity: 2, id: "evt-atc-0001" });
  assert.equal(add.status, 200);
  assert.deepEqual(await add.json(), { ok: true, sent: true });
  const out = await post({ kind: "checkout", source: "buy_now", variant: "gid://shopify/ProductVariant/424242", id: "evt-co-0001" });
  assert.deepEqual(await out.json(), { ok: true, sent: true });
  const cart = await post({ kind: "checkout", source: "checkout", id: "evt-co-0002" });
  assert.deepEqual(await cart.json(), { ok: true, sent: true });
  const sent = await eventsFrom(from, 3);
  assert.deepEqual(sent.map((e) => e.event_handle), ["hajirai.ava_added_to_cart", "hajirai.ava_checkout_started", "hajirai.ava_checkout_started"]);
  assert.deepEqual(sent[0].attributes, { product_id: 9001, product_handle: "ae-test-sneaker", variant_id: 424242, quantity: 2, added_value: 25990 }, "the catalog's price × quantity, in cents");
  assert.deepEqual(sent[1].attributes, { source: "buy_now", product_id: 9001, product_handle: "ae-test-sneaker", variant_id: 424242 });
  assert.deepEqual(sent[2].attributes, { source: "checkout" });
  // The same tap told twice: the same key, so Shopify keeps one.
  const again = appEvents.length;
  await post({ kind: "add_to_cart", variant: "424242", quantity: 2, id: "evt-atc-0001" });
  await eventsFrom(again, 1);
  assert.equal(appEvents.at(-1).idempotency_key, sent[0].idempotency_key);
  // Refused or ignored: an unknown variant, a made-up kind or source, junk, an unsigned request.
  const n = appEvents.length;
  assert.deepEqual(await (await post({ kind: "add_to_cart", variant: "999999999" })).json(), { ok: true, sent: false });
  assert.deepEqual(await (await post({ kind: "checkout", source: "elsewhere" })).json(), { ok: true, sent: false });
  assert.equal((await post({ kind: "refund" })).status, 400);
  assert.equal((await fetch(signed("/activity"), { method: "POST", body: "not json" })).status, 400);
  assert.ok((await fetch(`http://localhost:${APP_PORT}/activity?shop=${SHOP}`, { method: "POST", body: "{}" })).status >= 400, "unsigned refused");
  await settle();
  assert.equal(appEvents.length, n, "nothing sent for those");
  // The store turns it off (Settings → Integrations): nothing at all.
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { appEventsEnabled: false } });
  await configCacheExpiry();
  assert.equal((await (await fetch(signed("/widget-config"))).json()).appEvents, false, "the widget is told");
  assert.deepEqual(await (await post({ kind: "add_to_cart", variant: "424242" })).json(), { ok: true, sent: false });
  await chat("i need supportive sandals", { ip: "198.51.100.72", extra: { session_id: "sess-ae-2" } });
  await settle();
  assert.equal(appEvents.length, n, "off → no events at all");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { appEventsEnabled: true } });
  await configCacheExpiry();
  assert.equal((await (await fetch(signed("/widget-config"))).json()).appEvents, true);
  await prisma.productVariant.deleteMany({ where: { productId: p.id } });
  await prisma.product.delete({ where: { id: p.id } });
});
await test("the store's app: widget-config says it's on; the QR code is made only from the store's own link", async () => {
  const cfg = await (await fetch(signed("/widget-config"))).json();
  assert.deepEqual(cfg.appPromo, { on: true, ios: "", android: "", text: "", button: "" }, "on by default, links from the footer, the default text");
  assert.deepEqual(cfg.chatTexts, {}, "chat text: none set → the theme editor's");
  assert.equal(cfg.appPromo.image, undefined, "no app picture → the phone icon");
  assert.equal((await fetch(signed("/app-image", { v: "x" }))).status, 404, "no picture → nothing served");
  const pngBytes = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13];
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { appPromoImage: `data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}` } });
  await configCacheExpiry();
  const picPath = (await (await fetch(signed("/widget-config"))).json()).appPromo.image;
  assert.match(picPath, /^\/apps\/hajirai\/app-image\?v=[a-z0-9]+$/, "the picture's link, with its fingerprint");
  const pic = await fetch(signed("/app-image", { v: picPath.split("v=")[1] }));
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get("content-type"), "image/png");
  assert.deepEqual([...new Uint8Array(await pic.arrayBuffer())], pngBytes, "exactly the uploaded picture");
  const unsignedPic = await fetch(`http://localhost:${APP_PORT}/app-image?shop=${SHOP}&v=x`);
  assert.ok(unsignedPic.status >= 400 && unsignedPic.status < 500, `unsigned → ${unsignedPic.status}`);
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { appPromoOn: false } });
  await configCacheExpiry();
  assert.equal((await fetch(signed("/app-image", { v: "x" }))).status, 404, "app message off → no picture");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { appPromoOn: true, appPromoImage: "" } });
  await configCacheExpiry();
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { chatTexts: JSON.stringify({ startHeading: "Get started", popularHeading: "Trending", name: "" }) } });
  await configCacheExpiry();
  assert.deepEqual((await (await fetch(signed("/widget-config"))).json()).chatTexts, { startHeading: "Get started", popularHeading: "Trending" }, "chat text from Settings, blanks left out");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { chatTexts: "{}" } });
  await configCacheExpiry();
  assert.equal((await fetch(signed("/app-qr", { p: "ios" }))).status, 404, "no link set → no code");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { appIosUrl: "https://apps.apple.com/us/app/aetrex/id6789256421" } });
  await configCacheExpiry();
  const qr = await fetch(signed("/app-qr", { p: "ios" }));
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get("content-type"), "image/svg+xml");
  assert.match(await qr.text(), /^<svg[^>]+viewBox=/);
  assert.equal((await fetch(signed("/app-qr", { p: "android" }))).status, 404, "only the platforms with a link");
  const unsigned = await fetch(`http://localhost:${APP_PORT}/app-qr?shop=${SHOP}&p=ios`);
  assert.ok(unsigned.status >= 400 && unsigned.status < 500, `unsigned → ${unsigned.status}`);
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { appPromoText: "Love Aetrex? You’ll love our app", appPromoButton: "Get it" } });
  await configCacheExpiry();
  const own = (await (await fetch(signed("/widget-config"))).json()).appPromo;
  assert.equal(own.text, "Love Aetrex? You’ll love our app", "the message from Settings");
  assert.equal(own.button, "Get it", "the button from Settings");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { appPromoOn: false, appPromoText: "", appPromoButton: "" } });
  await configCacheExpiry();
  assert.deepEqual((await (await fetch(signed("/widget-config"))).json()).appPromo, { on: false });
  assert.equal((await fetch(signed("/app-qr", { p: "ios" }))).status, 404, "turned off → no code");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { appPromoOn: true, appIosUrl: "" } });
  await configCacheExpiry();
});
await test("test recordings: off by default; testers only; everyone; failures kept; widget-config tells the widget", async () => {
  const rows = () => prisma.chatRecording.findMany({ where: { shop: SHOP }, orderBy: { createdAt: "asc" } });
  const settle = () => new Promise((r) => setTimeout(r, 250));
  await chat("sandals for plantar fasciitis", { ip: "198.51.100.41", extra: { tester: "Ann", session_id: "sess-a", page: "/" } }); await settle();
  assert.equal((await rows()).length, 0, "off: nothing recorded, even for a tester");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { recordChatsUntil: new Date(Date.now() + 864e5), recordChatsScope: "testers" } });
  await configCacheExpiry();
  const cfg = await (await fetch(signed("/widget-config", { cta: "x" }))).json();
  assert.deepEqual(cfg.recording, { on: true, scope: "testers" });
  await chat("sandals for plantar fasciitis", { ip: "198.51.100.42", extra: { session_id: "sess-b", page: "/" } }); await settle();
  assert.equal((await rows()).length, 0, "testers only: an ordinary shopper isn't recorded");
  await chat("sandals for plantar fasciitis, email me at ann@example.com", { ip: "198.51.100.43", extra: { tester: "Ann", session_id: "sess-a", page: "/products/x?utm=1" } }); await settle();
  let r = await rows();
  assert.equal(r.length, 1, "the tester's turn is recorded");
  assert.equal(r[0].tester, "Ann");
  assert.equal(r[0].sessionId, "sess-a");
  assert.equal(r[0].page, "/products/x", "page path without the query");
  assert.match(r[0].message, /\[email\]/, "contact details removed");
  assert.match(r[0].reply, /supportive sandals/);
  assert.equal(r[0].products.length, 2);
  assert.equal(r[0].ok, true);
  await chat("FAIL please", { ip: "198.51.100.44", extra: { tester: "Ann", session_id: "sess-a" } }); await settle();
  r = await rows();
  assert.equal(r.at(-1).ok, false, "a failed turn is kept, marked failed");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { recordChatsScope: "everyone" } });
  await configCacheExpiry();
  await chat("sandals for plantar fasciitis", { ip: "198.51.100.45", extra: { session_id: "sess-c" } }); await settle();
  r = await rows();
  assert.equal(r.at(-1).sessionId, "sess-c", "everyone: an ordinary shopper is recorded");
  assert.equal(r.at(-1).typed, null, "an older widget doesn't say how it was sent");
  await chat("Help me find my orthotic FIT.", { ip: "198.51.100.46", extra: { session_id: "sess-c", typed: false } }); await settle();
  assert.equal((await rows()).at(-1).typed, false, "sent by a button");
  await chat("do you have wide sandals", { ip: "198.51.100.47", extra: { session_id: "sess-c", typed: true } }); await settle();
  assert.equal((await rows()).at(-1).typed, true, "typed by the shopper");
  await chat("sandals", { ip: "198.51.100.48", extra: { session_id: "sess-c", typed: "yes" } }); await settle();
  assert.equal((await rows()).at(-1).typed, null, "anything but true/false is unknown");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { recordChatsUntil: null, recordChatsScope: "testers" } });
  await configCacheExpiry();
});

console.log("\nbusy days (Settings → Peak Mode)");
await test("past the store's per-minute limit, a shopper gets the friendly busy note (and it's recorded)", async () => {
  const a = await chat("sandals please", { shop: BUSY_SHOP, ip: "198.51.100.90" });
  const b = await chat("sandals please", { shop: BUSY_SHOP, ip: "198.51.100.91" });
  const c = await chat("sandals please", { shop: BUSY_SHOP, ip: "198.51.100.92" });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 429);
  assert.equal(c.body.error, "store_busy");
  assert.match(c.body.message, /Lots of shoppers are chatting right now — please try again in a minute/);
  await new Promise((r) => setTimeout(r, 200));
  const rows = await prisma.chatHealthEvent.findMany({ where: { shop: BUSY_SHOP, errorKind: "store_rate_limited" } });
  assert.equal(rows.length, 1);
});
await test("Peak Mode on → the higher peak limit applies at once", async () => {
  await prisma.shopConfig.update({ where: { shop: BUSY_SHOP }, data: { peakMode: "on" } });
  await configCacheExpiry();
  const r = await chat("sandals please", { shop: BUSY_SHOP, ip: "198.51.100.93" });
  assert.equal(r.status, 200, "3rd message this minute passes under the peak limit of 10");
});

console.log(`\npage views: ${PAGE_VIEWS} widget-config loads, 100 at a time`);
let pageViews = null;
await test(`${PAGE_VIEWS} storefront page views all get their settings`, async () => {
  const t0 = Date.now();
  const ms = [];
  let ok = 0;
  let next = 0;
  const worker = async () => {
    while (next < PAGE_VIEWS) {
      next += 1;
      const s0 = Date.now();
      const res = await fetch(signed("/widget-config", { cta: "What can I help you find today?" }));
      if (res.ok && Array.isArray((await res.json()).hideOnUrls)) ok += 1;
      ms.push(Date.now() - s0);
    }
  };
  await Promise.all(Array.from({ length: 100 }, worker));
  const wall = Date.now() - t0;
  ms.sort((x, y) => x - y);
  pageViews = { requests: PAGE_VIEWS, ok, perSecond: Math.round(PAGE_VIEWS / (wall / 1000)), p50Ms: ms[Math.floor(ms.length * 0.5)], p95Ms: ms[Math.floor(ms.length * 0.95)], maxMs: ms.at(-1) };
  console.log(`      ${JSON.stringify(pageViews)}`);
  assert.equal(ok, PAGE_VIEWS);
});

console.log(`\nload: ${LOAD} shoppers at once (each turn = 3 model steps × ${MODEL_DELAY_MS}ms)`);
let load = null;
await test(`${LOAD} simultaneous chats all complete correctly`, async () => {
  const t0 = Date.now();
  const runs = await Promise.all(Array.from({ length: LOAD }, (_, i) => chat("i need supportive sandals", { ip: `203.0.113.${i % 250}` })));
  const wall = Date.now() - t0;
  const ok = runs.filter((r) => r.events?.at(-1)?.type === "done" && r.events[1]?.products?.length === 2);
  const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
  const modelFloor = MODEL_DELAY_MS * 3;
  load = {
    shoppers: LOAD, completed: ok.length, wallMs: wall,
    p50Ms: ms[Math.floor(ms.length * 0.5)], p95Ms: ms[Math.floor(ms.length * 0.95)], maxMs: ms.at(-1),
    serverOverheadP50Ms: ms[Math.floor(ms.length * 0.5)] - modelFloor,
    serverOverheadP95Ms: ms[Math.floor(ms.length * 0.95)] - modelFloor,
  };
  console.log(`      ${JSON.stringify(load)}`);
  assert.equal(ok.length, LOAD);
});

console.log("\ndeploys");
await test("on SIGTERM the server takes no new work but finishes a chat in progress, then exits", async () => {
  const p = chat("SLOW sandals", { ip: "198.51.100.95" });
  await new Promise((r) => setTimeout(r, 1500));
  const exited = new Promise((r) => server.once("exit", (code) => r(code)));
  server.kill("SIGTERM");
  const r = await p;
  assert.equal(r.events?.at(-1)?.type, "done", "the chat in progress finished");
  assert.equal(r.events[1]?.products?.length, 2);
  assert.equal(await exited, 0, "clean exit after the last request");
  assert.match(serverLog, /SIGTERM: finishing requests in flight/);
});

server.kill();
mock.close();
eventsMock.close();
for (const shop of [SHOP, BUSY_SHOP]) {
  for (const m of ["chatHealthEvent", "chatUsage", "chatFeedback", "chatTopic", "chatProductMention", "chatRecording", "shopConfig", "session"]) await prisma[m].deleteMany({ where: { shop } });
}
await prisma.product.deleteMany({ where: { shop: SHOP } });
await prisma.$disconnect();
if (failed) console.log("\n--- server log (tail) ---\n" + serverLog.split("\n").slice(-40).join("\n"));
// A failure: the server's own lines about it.
if (failed) console.log(serverLog.split("\n").filter((l) => /app-events|activity|error/i.test(l)).slice(-25).join("\n"));
console.log(`\n${passed} passed, ${failed} failed`);
console.log(JSON.stringify({ integration: { passed, failed, results, load, pageViews, products: productCount, at: new Date().toISOString() } }));
process.exit(failed ? 1 : 0);
