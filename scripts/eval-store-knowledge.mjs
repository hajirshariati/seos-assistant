// Store-knowledge eval — the assistant learns policies and pages from the
// store's own website (no upload needed), and uploaded notes stay the override.
//
// Offline: Shopify-like HTML fixtures, a fake Admin API (with and without the
// content scopes) and a stub fetch for the public storefront.
//
// Run: node scripts/eval-store-knowledge.mjs

import assert from "node:assert/strict";
import { register } from "node:module";

const HOOK = `export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && (spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?jsx?$/.test(spec)) return next(spec + ".js", ctx);
    throw e;
  }
}`;
register("data:text/javascript," + encodeURIComponent(HOOK));

// In-memory prisma: just the KnowledgeChunk + ShopConfig calls the sync uses.
const chunks = [];
let nextId = 1;
const matches = (row, where = {}) => Object.entries(where).every(([k, v]) =>
  v && typeof v === "object" && "startsWith" in v ? String(row[k] || "").startsWith(v.startsWith) : row[k] === v);
global.prismaGlobal = {
  knowledgeChunk: {
    deleteMany: async ({ where }) => {
      let count = 0;
      for (let i = chunks.length - 1; i >= 0; i--) if (matches(chunks[i], where)) { chunks.splice(i, 1); count++; }
      return { count };
    },
    create: async ({ data }) => { const row = { id: `c${nextId++}`, createdAt: new Date(), ...data }; chunks.push(row); return row; },
    findMany: async ({ where }) => chunks.filter((r) => matches(r, where))
      .sort((a, b) => a.sourceFileId.localeCompare(b.sourceFileId) || a.chunkIndex - b.chunkIndex),
  },
  shopConfig: { findUnique: async () => ({ shop: "demo.myshopify.com" }), create: async ({ data }) => data },
  $executeRawUnsafe: async () => 0,
};

const { htmlToText, parseSitemap, splitSections, toKnowledgeDoc } = await import("../app/lib/store-knowledge/extract.js");
const { syncStoreKnowledge, lexicalStoreKnowledge, listStoreKnowledge, STORE_SOURCE_PREFIX } = await import("../app/lib/store-knowledge/sync.server.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.log(`  ✗ ${name} — ${err.message}`); }
}

// ── Fixtures ──────────────────────────────────────────────────────
const shell = (main) => `<!doctype html><html><head><title>Shipping &amp; Returns | Aetrex</title><style>.x{}</style><script>var a=1</script></head>
<body><div class="announcement-bar">Free shipping on orders $75+</div>
<header><nav><a href="/">Shop</a><a href="/pages/about">About</a></nav></header>
<main id="MainContent">${main}</main>
<footer><p>© 2026 Aetrex. Newsletter sign up</p><form><input name="email"><button>Subscribe</button></form></footer></body></html>`;

const RETURNS_PAGE = shell(`
<div class="breadcrumb"><a href="/">Home</a> / Shipping</div>
<h1>Shipping &amp; Returns</h1>
<div class="mobile-only"><p>We offer free returns within 30 days of delivery on unworn shoes in original packaging.</p></div>
<div class="desktop-only"><p>We offer free returns within 30 days of delivery on unworn shoes in original packaging.</p></div>
<h2>Shipping</h2>
<p>Standard shipping is free on orders over $75 and arrives in 3&ndash;5 business days.</p>
<ul><li>Expedited: 2 business days, $15</li><li>Overnight: 1 business day, $30</li></ul>
<h2>Customer Service Hours</h2>
<table><tr><td>Monday&ndash;Friday</td><td>9am&ndash;6pm ET</td></tr><tr><td>Saturday</td><td>10am&ndash;3pm ET</td></tr></table>
<p>Call 1-800-555-0100 or email care@example.com. Our team answers every message within one business day, so please reach out with any questions about your order.</p>
`);

const REFUND_POLICY = shell(`<div class="shopify-policy__container"><h1>Refund policy</h1>
<div class="shopify-policy__body"><p>Items can be returned within 30 days of delivery. Orthotics carry a 60-day comfort guarantee: if they aren't comfortable, return them for a full refund. Final-sale items cannot be returned. Refunds go to the original payment method within 5&ndash;7 business days of receiving the return.</p></div></div>`);

const SHIPPING_POLICY = shell(`<h1>Shipping policy</h1><p>We ship to the United States and Canada. Orders placed before 2pm ET ship the same business day. International orders may be subject to duties and taxes collected by the carrier at delivery.</p>`);

const SITEMAP_INDEX = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://www.aetrex.test/sitemap_products_1.xml?from=1&amp;to=99</loc></sitemap>
<sitemap><loc>https://www.aetrex.test/sitemap_pages_1.xml</loc></sitemap></sitemapindex>`;
const SITEMAP_PAGES = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://www.aetrex.test/pages/shipping-returns</loc></url>
<url><loc>https://www.aetrex.test/pages/empty</loc></url></urlset>`;

function stubFetch(routes, log = []) {
  return async (url) => {
    log.push(url);
    const body = routes[url];
    return body == null
      ? { ok: false, status: 404, text: async () => "" }
      : { ok: true, status: 200, text: async () => body };
  };
}

const WEB = {
  "https://www.aetrex.test/policies/refund-policy": REFUND_POLICY,
  "https://www.aetrex.test/policies/shipping-policy": SHIPPING_POLICY,
  "https://www.aetrex.test/sitemap.xml": SITEMAP_INDEX,
  "https://www.aetrex.test/sitemap_pages_1.xml": SITEMAP_PAGES,
  "https://www.aetrex.test/pages/shipping-returns": RETURNS_PAGE,
  "https://www.aetrex.test/pages/empty": shell("<h1>Empty</h1>"),
};

function fakeAdmin({ scopes = true } = {}) {
  const calls = [];
  return {
    calls,
    graphql: async (query) => {
      calls.push(query);
      const ok = (data) => ({ json: async () => ({ data }) });
      const denied = () => ({ json: async () => ({ errors: [{ message: "Access denied for pages field. Required access: `read_content` access scope." }] }) });
      if (/primaryDomain/.test(query)) return ok({ shop: { primaryDomain: { url: "https://www.aetrex.test/" } } });
      if (/shopPolicies/.test(query)) {
        return scopes
          ? ok({ shop: { shopPolicies: [
            { type: "REFUND_POLICY", title: "Refund policy", url: "https://www.aetrex.test/policies/refund-policy", body: "<p>Items can be returned within 30 days of delivery. Orthotics carry a 60-day comfort guarantee. Final-sale items cannot be returned.</p><p>Refunds are issued to the original payment method.</p>" },
            { type: "PRIVACY_POLICY", title: "Privacy policy", url: "https://www.aetrex.test/policies/privacy-policy", body: "" },
          ] } })
          : denied();
      }
      if (/pages\(/.test(query)) {
        return scopes
          ? ok({ pages: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
            { title: "Shipping & Returns", handle: "shipping-returns", body: "", isPublished: true },
            { title: "Our Story", handle: "about", body: "<h2>Founded in 1946</h2><p>Aetrex has spent decades studying feet. Our foot scanners have measured millions of feet, and that data shapes every orthotic and shoe we design for all-day comfort and support.</p>", isPublished: true },
            { title: "Draft page", handle: "draft", body: "<p>" + "Not live yet. ".repeat(30) + "</p>", isPublished: false },
          ] } })
          : denied();
      }
      return ok({});
    },
  };
}

// ── Extraction ────────────────────────────────────────────────────
console.log("\nextraction");

await test("htmlToText keeps the page's content and drops theme chrome", () => {
  const t = htmlToText(RETURNS_PAGE);
  assert.match(t, /free returns within 30 days/);
  assert.match(t, /Standard shipping is free on orders over \$75/);
  for (const junk of ["var a=1", "Newsletter", "Subscribe", "Home / Shipping", "Free shipping on orders $75+", "Shop"]) {
    assert.ok(!t.includes(junk), `should drop "${junk}"`);
  }
});

await test("headings become sections, lists and tables stay readable, entities decode", () => {
  const t = htmlToText(RETURNS_PAGE);
  assert.match(t, /^## Shipping & Returns/m);
  assert.match(t, /^## Customer Service Hours/m);
  assert.match(t, /^- Expedited: 2 business days, \$15$/m);
  assert.match(t, /Monday–Friday \| 9am–6pm ET/);
});

await test("the duplicate mobile/desktop block appears once", () => {
  const t = htmlToText(RETURNS_PAGE);
  assert.equal(t.split("We offer free returns within 30 days").length - 1, 1);
});

await test("parseSitemap reads index and url sets", () => {
  const idx = parseSitemap(SITEMAP_INDEX);
  assert.equal(idx.urls.length, 0);
  assert.ok(idx.sitemaps.includes("https://www.aetrex.test/sitemap_pages_1.xml"));
  assert.ok(idx.sitemaps[0].includes("&to=99"), "entities decoded in <loc>");
  assert.deepEqual(parseSitemap(SITEMAP_PAGES).urls.length, 2);
});

await test("splitSections tags each section and folds tiny ones into the previous", () => {
  const doc = toKnowledgeDoc({ kind: "page", handle: "shipping-returns", title: "Shipping & Returns", url: "u", text: htmlToText(RETURNS_PAGE) });
  const secs = splitSections(doc.content);
  const hours = secs.find((s) => s.heading === "Customer Service Hours");
  assert.ok(hours, "hours section present");
  assert.match(hours.text, /Saturday \| 10am–3pm ET/);
  assert.ok(secs.every((s) => s.text.length > 0));
  assert.ok(!secs.some((s) => s.heading === "Shipping & Returns" && s.text.length < 20), "no empty heading-only section");
});

// ── Sync: without content scopes (public storefront fallback) ────
console.log("\nsync — app not yet approved for read_content / read_legal_policies");

await test("falls back to /policies/* and the sitemap, stores chunks labelled store_*", async () => {
  chunks.length = 0;
  chunks.push({ id: "up1", shop: "demo.myshopify.com", sourceFileId: "file_123", fileType: "faqs", content: "uploaded note", chunkIndex: 0 });
  const fetched = [];
  const logs = [];
  const r = await syncStoreKnowledge({ admin: fakeAdmin({ scopes: false }), shop: "demo.myshopify.com", fetchImpl: stubFetch(WEB, fetched), log: (l) => logs.push(l) });
  assert.equal(r.ok, true, logs.join("\n"));
  assert.equal(r.policiesSource, "web");
  assert.equal(r.pagesSource, "sitemap");
  assert.equal(r.docs, 3, "refund + shipping policy + shipping-returns page (empty page skipped)");
  assert.ok(fetched.includes("https://www.aetrex.test/sitemap_pages_1.xml"));
  assert.ok(!fetched.some((u) => /sitemap_products/.test(u)), "product sitemap not crawled");
  assert.ok(!logs.some((l) => /failed/.test(l)), "access-denied is expected, not logged as failure");
  const store = chunks.filter((c) => c.sourceFileId.startsWith(STORE_SOURCE_PREFIX));
  assert.ok(store.length >= 3);
  assert.ok(store.every((c) => /^store_(policy|page)$/.test(c.fileType)));
  assert.ok(chunks.some((c) => c.id === "up1"), "uploaded knowledge untouched");
});

await test("page title comes from the live <title>, sections carry their heading", async () => {
  const page = chunks.filter((c) => c.sourceFileId === "store:page:shipping-returns");
  assert.ok(page.length >= 2);
  assert.ok(page.every((c) => c.sectionTitle.startsWith("Shipping & Returns")));
  assert.ok(page.some((c) => c.sectionTitle === "Shipping & Returns — Customer Service Hours"));
  assert.deepEqual(page.map((c) => c.chunkIndex), page.map((_, i) => i));
});

await test("customer questions find the right website facts", async () => {
  const hours = await lexicalStoreKnowledge("demo.myshopify.com", "what are your customer service hours");
  assert.ok(hours.length > 0 && hours.some((c) => /9am–6pm ET/.test(c.content)), "hours found");
  const orth = await lexicalStoreKnowledge("demo.myshopify.com", "can I return orthotics guarantee");
  assert.ok(orth.some((c) => /60-day comfort guarantee/.test(c.content)), "orthotic guarantee found");
  const intl = await lexicalStoreKnowledge("demo.myshopify.com", "do you ship to canada");
  assert.ok(intl.some((c) => /United States and Canada/.test(c.content)), "shipping countries found");
});

await test("admin list shows one row per learned document with its link", async () => {
  const list = await listStoreKnowledge("demo.myshopify.com");
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((d) => d.kind), ["Page", "Policy", "Policy"]);
  const page = list.find((d) => d.kind === "Page");
  assert.equal(page.title, "Shipping & Returns");
  assert.equal(page.url, "https://www.aetrex.test/pages/shipping-returns");
});

// ── Sync: with content scopes (Admin API) ────────────────────────
console.log("\nsync — app approved for the content scopes");

await test("uses Admin policies + pages, reads theme-built pages live, skips drafts", async () => {
  const fetched = [];
  const r = await syncStoreKnowledge({ admin: fakeAdmin({ scopes: true }), shop: "demo.myshopify.com", fetchImpl: stubFetch(WEB, fetched), log: () => {} });
  assert.equal(r.policiesSource, "admin");
  assert.equal(r.pagesSource, "admin");
  assert.equal(r.docs, 3, "refund policy (privacy empty) + shipping-returns + about (draft skipped)");
  assert.ok(fetched.includes("https://www.aetrex.test/pages/shipping-returns"), "empty-body page read from the live site");
  assert.ok(!fetched.some((u) => /\/policies\//.test(u)), "no public policy fetch when the API works");
  const ids = new Set(chunks.filter((c) => c.sourceFileId.startsWith(STORE_SOURCE_PREFIX)).map((c) => c.sourceFileId));
  assert.deepEqual([...ids].sort(), ["store:page:about", "store:page:shipping-returns", "store:policy:refund-policy"]);
  assert.ok(chunks.some((c) => c.id === "up1"), "uploaded knowledge still untouched");
});

await test("a sync that collects nothing keeps the previous store knowledge", async () => {
  const before = chunks.length;
  const r = await syncStoreKnowledge({ admin: fakeAdmin({ scopes: false }), shop: "demo.myshopify.com", fetchImpl: stubFetch({}), log: () => {} });
  assert.equal(r.ok, false);
  assert.equal(chunks.length, before);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
