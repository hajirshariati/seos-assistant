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
const APP_PORT = 3990 + Math.floor(Math.random() * 9);
const MODEL_PORT = APP_PORT + 100;
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
  await prisma.shopConfig.create({ data: { shop: SHOP, anthropicApiKey: encrypt("sk-ant-test"), anthropicModel: "claude-sonnet-4-20250514" } });
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
      modelCalls.push({ model: r.model, at: Date.now() });
      const msgs = r.messages || [];
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

// ── signed app-proxy requests ──
function signed(pathname, extra = {}) {
  const p = new URLSearchParams({ shop: SHOP, logged_in_customer_id: "", path_prefix: "/apps/hajirai", timestamp: String(Math.floor(Date.now() / 1000)), ...extra });
  const msg = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("");
  p.set("signature", crypto.createHmac("sha256", SECRET).update(msg).digest("hex"));
  return `http://localhost:${APP_PORT}${pathname}?${p}`;
}
async function chat(message, { ip = "198.51.100.1", history = [], signal, extra = {} } = {}) {
  const t0 = Date.now();
  const res = await fetch(signed("/chat"), {
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

const productCount = await seed();
const mock = modelServer();
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env, NODE_ENV: "production", PORT: String(APP_PORT), DATABASE_URL: DB, ENCRYPTION_KEY,
    SHOPIFY_API_KEY: "integration-key", SHOPIFY_API_SECRET: SECRET, SHOPIFY_APP_URL: `http://localhost:${APP_PORT}`, SCOPES: "read_products",
    ANTHROPIC_BASE_URL: `http://localhost:${MODEL_PORT}`, DISABLE_CATALOG_SYNC_SCHEDULER: "true",
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
  const fb = await fetch(signed("/feedback"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vote: "up", session: "s", botResponse: "ok" }) });
  assert.equal(fb.status, 200);
  const viz = await fetch(signed("/visualize"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productHandle: "x" }) });
  assert.equal(viz.status, 403, "feature off for this store → refused, no image call");
});

await test("test recordings: off by default; testers only; everyone; failures kept; widget-config tells the widget", async () => {
  const rows = () => prisma.chatRecording.findMany({ where: { shop: SHOP }, orderBy: { createdAt: "asc" } });
  const settle = () => new Promise((r) => setTimeout(r, 250));
  await chat("sandals for plantar fasciitis", { ip: "198.51.100.41", extra: { tester: "Ann", session_id: "sess-a", page: "/" } }); await settle();
  assert.equal((await rows()).length, 0, "off: nothing recorded, even for a tester");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { recordChatsUntil: new Date(Date.now() + 864e5), recordChatsScope: "testers" } });
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
  await chat("sandals for plantar fasciitis", { ip: "198.51.100.45", extra: { session_id: "sess-c" } }); await settle();
  r = await rows();
  assert.equal(r.at(-1).sessionId, "sess-c", "everyone: an ordinary shopper is recorded");
  await prisma.shopConfig.update({ where: { shop: SHOP }, data: { recordChatsUntil: null, recordChatsScope: "testers" } });
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
  assert.equal(ok.length, LOAD);
});

server.kill();
mock.close();
for (const m of ["chatHealthEvent", "chatUsage", "chatFeedback", "chatTopic", "chatProductMention", "chatRecording", "shopConfig", "session"]) await prisma[m].deleteMany({ where: { shop: SHOP } });
await prisma.product.deleteMany({ where: { shop: SHOP } });
await prisma.$disconnect();
if (failed) console.log("\n--- server log (tail) ---\n" + serverLog.split("\n").slice(-40).join("\n"));
console.log(`\n${passed} passed, ${failed} failed`);
console.log(JSON.stringify({ integration: { passed, failed, results, load, products: productCount, at: new Date().toISOString() } }));
process.exit(failed ? 1 : 0);
