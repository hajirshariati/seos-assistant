// Store-knowledge eval — the assistant learns policies and pages from the
// store's own website (no upload needed), and uploaded notes stay the override.
//
// Offline: Shopify-like HTML fixtures, a theme page template shaped like the
// real Aetrex clinical-study page, blog articles, a fake Admin API (with and
// without the content scopes) and a stub fetch for the public storefront.
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
const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === "object" && "startsWith" in v) return String(row[k] || "").startsWith(v.startsWith);
  if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
  return row[k] === v;
});
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
  $queryRawUnsafe: async () => [],
};

const { htmlToText, parseSitemap, splitSections, toKnowledgeDoc, themeTemplateText } = await import("../app/lib/store-knowledge/extract.js");
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

function fakeAdmin({ scopes = true, pages = null, articles = [], templates = {}, themes = true, articlesOk = true } = {}) {
  const calls = [];
  return {
    calls,
    graphql: async (query, opts) => {
      const variables = opts?.variables;
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
      if (/themes\(first/.test(query)) return scopes && themes ? ok({ themes: { nodes: [{ id: "gid://shopify/OnlineStoreTheme/1" }] } }) : denied();
      if (/theme\(id/.test(query)) {
        const nodes = (variables?.filenames || []).filter((f) => templates[f]).map((f) => ({ filename: f, body: { content: templates[f] } }));
        return ok({ theme: { files: { nodes } } });
      }
      if (/articles\(/.test(query)) {
        return scopes && articlesOk ? ok({ articles: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: articles } }) : denied();
      }
      if (/pages\(/.test(query) && pages) {
        return scopes ? ok({ pages: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: pages } }) : denied();
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


// ── The whole published site: theme-built pages, study links, blog ──
console.log("\nthe whole published site — theme-built pages, outside links, blog articles");

// Shaped like Aetrex's real templates/page.case-premmem.json: the words live
// in section settings, the page body is empty.
const CASE_TEMPLATE = `/*
 * IMPORTANT: The contents of this file are auto-generated.
 */
${JSON.stringify({
  sections: {
    "main-page": { type: "main-page", disabled: true, settings: { heading_size: "title-xl tracking-heading", heading_tag: "h1", padding_top: 72 } },
    hero: {
      type: "image-with-text-overlay",
      blocks: {
        h: { type: "heading", settings: { heading: "<p>Clinically Proven to Relieve Foot Pain and More!*</p>", heading_size: "title-md", heading_tag: "h4", highlighted_text: "none", highlighted_scribble: "circle" } },
        t: { type: "text", settings: { text: "<p>Aetrex Premium Memory Foam Orthotics</p>", text_font: "body", text_size: "subtext-md", secondary_color: true } },
        b1: { type: "button", settings: { button_label: "SHOP PREMIUM ORTHOTICS", button_link: "shopify://collections/premium-memory-foam", button_video_link: "", button_style: "primary" } },
        b2: { type: "button", settings: { button_label: "READ THE STUDY", button_link: "https://www.tandfonline.com/doi/full/10.1080/02703181.2023.2215818" } },
      },
      block_order: ["h", "t", "b1", "b2"],
      settings: { image: "shopify://shop_images/PMFd.jpg", content_position: "md:items-center md:justify-start", color_text: "#ffffff" },
    },
    pain: {
      type: "image-with-text",
      blocks: {
        a: { type: "text", settings: { text: "<p>Reducing & Preventing Pain</p>" } },
        b: { type: "text", settings: { text: "<p>Aetrex Premium Memory Foam Orthotics are clinically proven to reduce common foot pains as well as pain in the back, hip, knee and ankle. Plus, they have been clinically proven to help reduce the fear of falling in older adults.</p>" } },
        x: { type: "text", disabled: true, settings: { text: "<p>Hidden block: 70% off today only</p>" } },
      },
      block_order: ["a", "b", "x"],
      settings: { layout: "text_first", img_url: "" },
    },
    old: { type: "rich-text", disabled: true, settings: { heading: "Old promo: 50% off everything" } },
    liquid: { type: "custom-liquid", settings: { custom_liquid: "<p>Rated {{ product.metafields.reviews.rating }} by wearers in the study group</p>" } },
    foot: { type: "rich-text", blocks: { a: { type: "text", settings: { text: "<p>* Clinical Study conducted in Liverpool, England by Dr. George Ampat, ** Statistics provided by the FHSQ Subscale & Falls Efficacy Scale used in the study</p>" } } }, block_order: ["a"], settings: {} },
  },
  order: ["main-page", "hero", "pain", "old", "liquid", "foot"],
}, null, 2)}`;

await test("theme template → text: hidden sections and styling dropped, buttons keep label and link", () => {
  const t = themeTemplateText(CASE_TEMPLATE, { domain: "https://www.aetrex.test" });
  assert.match(t, /^## Clinically Proven to Relieve Foot Pain and More!\*/m);
  assert.match(t, /clinically proven to reduce common foot pains as well as pain in the back, hip, knee and ankle/);
  assert.match(t, /READ THE STUDY: https:\/\/www\.tandfonline\.com\/doi\/full\/10\.1080\/02703181\.2023\.2215818/);
  assert.match(t, /SHOP PREMIUM ORTHOTICS: https:\/\/www\.aetrex\.test\/collections\/premium-memory-foam/);
  assert.match(t, /Liverpool, England by Dr\. George Ampat/);
  for (const junk of ["70% off", "50% off", "title-xl", "#ffffff", "md:items-center", "shop_images", "{{", "metafields", "none", "circle"]) {
    assert.ok(!t.includes(junk), `should drop "${junk}"`);
  }
});

await test("links to outside sources are kept; store links, old URLs and share buttons are just text", () => {
  const t = htmlToText('<p>See <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC1/x.pdf">the published trial</a>, our <a href="https://www.aetrex.test/blog.html?p=old">old post</a>, <a href="/pages/about">story</a> and <a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>.</p>', { ownHosts: ["www.aetrex.test", "demo.myshopify.com"] });
  assert.match(t, /the published trial \(https:\/\/pmc\.ncbi\.nlm\.nih\.gov\/articles\/PMC1\/x\.pdf\)/);
  assert.ok(!/blog\.html|\/pages\/about|facebook/.test(t), t);
  assert.match(t, /our old post, story and Share/);
});

// Shaped like Aetrex's templates/page.faq-shipping.json (question blocks).
const FAQ_TEMPLATE = JSON.stringify({
  sections: {
    main: { type: "main-page", disabled: true, settings: { heading_size: "title-xl", heading_tag: "h1" } },
    faq: {
      type: "faq",
      blocks: {
        "rich-text-1": { type: "rich-text", settings: { heading: "Shipping", text: "", highlighted_text: "none", highlighted_scribble: "circle" } },
        "question-1": { type: "question", settings: { title: "Which carrier do you use to ship my online order?", text: "<p>Orders are shipped via UPS Ground and USPS First Class as the default shipping method. <strong>WE SHIP TO P.O. BOXES but we do not ship to APO BOXES.</strong></p>", highlighted_text: "none" } },
        "question-2": { type: "question", settings: { title: "Where do you ship from?", text: "<p>All items are shipped from our warehouse facility and order fulfillment centers in <strong>New Jersey or Missouri.</strong></p>" } },
      },
      block_order: ["rich-text-1", "question-1", "question-2"],
      settings: { style: "with-border", heading: "Shipping & Delivery FAQs", heading_size: "title-md", heading_alignment: "text-left md:items-end md:flex-row", abra_promo_code_show: "" },
    },
  },
  order: ["main", "faq"],
});

await test("an FAQ template keeps each question as a heading with its answer", () => {
  const t = themeTemplateText(FAQ_TEMPLATE, { domain: "https://www.aetrex.test" });
  assert.match(t, /^## Shipping & Delivery FAQs$/m);
  assert.match(t, /^## Shipping$/m, "one-word heading kept");
  assert.match(t, /^## Which carrier do you use to ship my online order\?\n\nOrders are shipped via UPS Ground/m);
  assert.match(t, /New Jersey or Missouri/);
  assert.ok(!/with-border|title-md|none|circle/.test(t), t);
});

const ARTICLES = [
  {
    title: "Plantar Fasciitis Exercises: 10 Steps To Help Relieve Pain", handle: "plantar-fasciitis-exercises", isPublished: true, publishedAt: "2023-08-06T21:07:00Z",
    tags: ["Foot Health & Wellness"], blog: { handle: "aetrex-blog", title: "Aetrex Blog" }, summary: "",
    body: "<p>Plantar fasciitis is a common type of inflammation that occurs when the plantar fascia is excessively stretched. The pain is commonly felt in the arch and heel.</p><h3>Exercises</h3><p><strong>1. Towel Curls</strong> Sit down in a chair with your heels under your knees and pull the towel toward you with your toes. Repeat 4-5 times.</p><p>Watch: <iframe src=\"//www.youtube.com/embed/x\"></iframe></p>",
  },
  {
    title: "Draft: winter boots", handle: "draft-winter", isPublished: false, publishedAt: null, tags: [], blog: { handle: "aetrex-blog", title: "Aetrex Blog" }, summary: "",
    body: "<p>" + "Not live yet. ".repeat(30) + "</p>",
  },
  {
    title: "Aetrex in the News", handle: "aetrex-news-2024", isPublished: true, publishedAt: "2024-03-01T12:00:00Z", tags: [], blog: { handle: "news", title: "News" }, summary: "",
    body: "<p>Aetrex was named one of the most trusted comfort footwear brands by a national survey of podiatrists, recognising decades of work on arch support and foot scanning.</p>",
  },
];
const SITE_PAGES = [
  { title: "Premium Memory Foam Case Study", handle: "case-premmem", body: "", isPublished: true, templateSuffix: "case-premmem" },
  { title: "Our Story", handle: "about", body: "<h2>Founded in 1946</h2><p>Aetrex has spent decades studying feet. Our foot scanners have measured millions of feet, and that data shapes every orthotic and shoe we design for all-day comfort and support.</p>", isPublished: true, templateSuffix: null },
];
const siteAdmin = (over = {}) => fakeAdmin({ pages: SITE_PAGES, articles: ARTICLES, templates: { "templates/page.case-premmem.json": CASE_TEMPLATE }, ...over });

await test("a theme-built page is read from its theme template — no live fetch needed", async () => {
  chunks.length = 0;
  const fetched = [];
  const r = await syncStoreKnowledge({ admin: siteAdmin(), shop: "demo.myshopify.com", fetchImpl: stubFetch({}, fetched), log: () => {} });
  assert.equal(r.ok, true);
  assert.ok(!fetched.some((u) => /case-premmem/.test(u)), "template text was enough");
  const page = chunks.filter((c) => c.sourceFileId === "store:page:case-premmem");
  assert.ok(page.some((c) => /pain in the back, hip, knee and ankle/.test(c.content)));
  assert.ok(page.some((c) => /tandfonline\.com\/doi/.test(c.content)), "study link stored");
});

await test("published blog articles are learned with their blog link, date and topics; drafts skipped", async () => {
  const arts = chunks.filter((c) => c.fileType === "store_article");
  const ids = new Set(arts.map((c) => c.sourceFileId));
  assert.deepEqual([...ids].sort(), ["store:article:aetrex-blog/plantar-fasciitis-exercises", "store:article:news/aetrex-news-2024"]);
  const pf = arts.filter((c) => c.sourceFileId.endsWith("plantar-fasciitis-exercises"));
  assert.match(pf[0].content, /Source: https:\/\/www\.aetrex\.test\/blogs\/aetrex-blog\/plantar-fasciitis-exercises/);
  assert.ok(pf.some((c) => /published 2023-08-06/.test(c.content) && /Foot Health & Wellness/.test(c.content)));
  assert.ok(!arts.some((c) => /youtube/.test(c.content)), "embeds dropped");
});

await test("every stored chunk carries its page link", () => {
  const store = chunks.filter((c) => c.sourceFileId.startsWith(STORE_SOURCE_PREFIX));
  assert.ok(store.length >= 4);
  for (const c of store) assert.match(c.content, /Source: https:\/\/www\.aetrex\.test\//, c.sectionTitle);
});

await test("a clinical-claims question finds the store's claim, the study's author and the study link", async () => {
  const hits = await lexicalStoreKnowledge("demo.myshopify.com", "Are Aetrex Premium Memory Foam Orthotics clinically proven to reduce knee, hip and back pain?");
  const text = hits.map((c) => c.content).join("\n");
  assert.match(text, /clinically proven to reduce common foot pains as well as pain in the back, hip, knee and ankle/);
  assert.match(text, /tandfonline\.com|case-premmem/);
  const who = await lexicalStoreKnowledge("demo.myshopify.com", "who conducted the clinical study");
  assert.ok(who.some((c) => /Dr\. George Ampat/.test(c.content)));
  const pf = await lexicalStoreKnowledge("demo.myshopify.com", "exercises for plantar fasciitis");
  assert.ok(pf.some((c) => /Towel Curls/.test(c.content)));
});

await test("admin list labels blog articles", async () => {
  const list = await listStoreKnowledge("demo.myshopify.com");
  assert.deepEqual([...new Set(list.map((d) => d.kind))].sort(), ["Article", "Page", "Policy"]);
  assert.ok(list.some((d) => d.kind === "Article" && d.url === "https://www.aetrex.test/blogs/news/aetrex-news-2024"));
});

await test("re-sync with nothing changed keeps every chunk (no re-embedding); one edit replaces only that article", async () => {
  const before = new Map(chunks.map((c) => [c.id, c.sourceFileId]));
  const same = await syncStoreKnowledge({ admin: siteAdmin(), shop: "demo.myshopify.com", fetchImpl: stubFetch({}), log: () => {} });
  assert.equal(same.added, 0);
  assert.equal(same.removed, 0);
  assert.deepEqual(chunks.map((c) => c.id).sort(), [...before.keys()].sort());
  const edited = ARTICLES.map((a) => (a.handle === "aetrex-news-2024" ? { ...a, body: a.body.replace("national survey", "2025 national survey") } : a));
  const r = await syncStoreKnowledge({ admin: siteAdmin({ articles: edited }), shop: "demo.myshopify.com", fetchImpl: stubFetch({}), log: () => {} });
  assert.ok(r.added >= 1 && r.removed === r.added, JSON.stringify(r));
  const kept = chunks.filter((c) => before.has(c.id));
  assert.ok(kept.every((c) => c.sourceFileId !== "store:article:news/aetrex-news-2024"));
  assert.ok(chunks.some((c) => /2025 national survey/.test(c.content)));
});

await test("if articles can't be read this time, the articles already learned stay", async () => {
  const had = chunks.filter((c) => c.fileType === "store_article").length;
  const r = await syncStoreKnowledge({ admin: siteAdmin({ articlesOk: false }), shop: "demo.myshopify.com", fetchImpl: stubFetch({}), log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(chunks.filter((c) => c.fileType === "store_article").length, had);
});

await test("without theme access, every thin page is read live — no cap on how many", async () => {
  chunks.length = 0;
  const many = Array.from({ length: 160 }, (_, i) => ({ title: `Tech ${i}`, handle: `tech-${i}`, body: "", isPublished: true, templateSuffix: `tech-${i}` }));
  const web = Object.fromEntries(many.map((p) => [`https://www.aetrex.test/pages/${p.handle}`, shell(`<h1>Tech ${p.handle}</h1><p>${"Aetrex technology explained in detail for comfort and support. ".repeat(4)}</p>`)]));
  const fetched = [];
  const r = await syncStoreKnowledge({ admin: fakeAdmin({ pages: many, themes: false }), shop: "demo.myshopify.com", fetchImpl: stubFetch(web, fetched), log: () => {} });
  assert.equal(fetched.filter((u) => /\/pages\/tech-/.test(u)).length, 160);
  assert.equal(r.docs, 161, "160 pages + the refund policy");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
