// Store knowledge — learn the store from its own website, automatically.
//
// Reads the store's policies (refund, shipping, terms, privacy, contact) and
// published pages (shipping, returns, FAQ, about, size guide…) and stores
// them as knowledge chunks the chat already searches — so the merchant never
// has to re-upload what's on their site. Uploaded knowledge files stay the
// override: they're labelled as the store team's notes and win on conflict.
//
// Admin API first (needs read_legal_policies / read_content); if the app
// doesn't have those yet, the public storefront (policy pages + sitemap) is
// used instead. Theme-built pages with an empty body are read from the live
// page. Runs after every catalog sync and from the Knowledge page.

import prisma from "../../db.server.js";
import { getShopConfig } from "../../models/ShopConfig.server.js";
import { chunkKnowledgeFile, lexicalRetrieveChunks } from "../knowledge-chunks.server.js";
import { embedTexts, vectorLiteral, resolveShopEmbedding, EMBEDDING_DIMENSIONS } from "../embeddings.server.js";
import { decodeEntities, htmlToText, parseSitemap, POLICY_SLUGS, splitSections, toKnowledgeDoc } from "./extract.js";

export const STORE_SOURCE_PREFIX = "store:";
const MIN_TEXT_CHARS = 120;
const THIN_BODY_CHARS = 300;
const MAX_PAGES = 250;
const MAX_WEB_FETCHES = 120;
const FETCH_TIMEOUT_MS = 12000;

async function gql(admin, query, variables) {
  const resp = await admin.graphql(query, variables ? { variables } : undefined);
  const json = await resp.json();
  if (json?.errors?.length) {
    const msg = json.errors.map((e) => e.message).join("; ");
    const err = new Error(msg);
    err.accessDenied = /access denied|not approved|scope|ACCESS_DENIED/i.test(msg);
    throw err;
  }
  return json.data;
}

async function fetchText(url, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "SEoS-Assistant-KnowledgeSync/1.0", Accept: "text/html,application/xml" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const titleFromSlug = (slug) => String(slug || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ── Collect documents ─────────────────────────────────────────────

async function collectPolicies({ admin, domain, fetchImpl, log }) {
  try {
    const data = await gql(admin, `#graphql
      query { shop { shopPolicies { type title url body } } }`);
    const docs = (data?.shop?.shopPolicies || [])
      .map((p) => toKnowledgeDoc({ kind: "policy", handle: POLICY_SLUGS[p.type] || String(p.type).toLowerCase(), title: p.title, url: p.url, text: htmlToText(p.body) }))
      .filter((d) => d.chars >= MIN_TEXT_CHARS);
    return { docs, source: "admin" };
  } catch (err) {
    if (!err.accessDenied) log(`[store-knowledge] policies via admin failed: ${err.message}`);
  }
  // Public storefront fallback — every Shopify store serves /policies/<slug>.
  const slugs = ["refund-policy", "shipping-policy", "terms-of-service", "privacy-policy", "contact-information"];
  const docs = (await mapLimit(slugs, 3, async (slug) => {
    const url = `${domain}/policies/${slug}`;
    const html = await fetchText(url, fetchImpl);
    return html ? toKnowledgeDoc({ kind: "policy", handle: slug, title: titleFromSlug(slug), url, text: htmlToText(html) }) : null;
  })).filter((d) => d && d.chars >= MIN_TEXT_CHARS);
  return { docs, source: "web" };
}

async function collectPages({ admin, domain, fetchImpl, log }) {
  let pages = null;
  let source = "admin";
  try {
    pages = [];
    let after = null;
    while (pages.length < MAX_PAGES) {
      const data = await gql(admin, `#graphql
        query Pages($after: String) {
          pages(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { title handle body isPublished }
          }
        }`, { after });
      const conn = data?.pages;
      for (const n of conn?.nodes || []) if (n.isPublished !== false) pages.push(n);
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
  } catch (err) {
    if (!err.accessDenied) log(`[store-knowledge] pages via admin failed: ${err.message}`);
    pages = null;
  }

  if (!pages) {
    // Public fallback: the storefront sitemap lists every published page.
    source = "sitemap";
    pages = [];
    const index = await fetchText(`${domain}/sitemap.xml`, fetchImpl);
    const { sitemaps, urls } = parseSitemap(index);
    const pageMaps = sitemaps.filter((u) => /sitemap_pages/i.test(u));
    const pageUrls = [...urls.filter((u) => /\/pages\//.test(u))];
    for (const sm of pageMaps) pageUrls.push(...parseSitemap(await fetchText(sm, fetchImpl)).urls);
    for (const url of [...new Set(pageUrls)].slice(0, MAX_PAGES)) {
      const handle = url.split("/pages/")[1]?.split(/[?#]/)[0];
      if (handle) pages.push({ handle, title: titleFromSlug(handle), body: "", url });
    }
  }

  let webFetches = 0;
  const docs = (await mapLimit(pages, 4, async (p) => {
    const url = p.url || `${domain}/pages/${p.handle}`;
    let text = htmlToText(p.body);
    // Theme-built pages keep their content in sections, not the body.
    if (text.length < THIN_BODY_CHARS && webFetches < MAX_WEB_FETCHES) {
      webFetches += 1;
      const html = await fetchText(url, fetchImpl);
      const live = html ? htmlToText(html) : "";
      if (live.length > text.length) text = live;
      if (html && (!p.title || p.title === titleFromSlug(p.handle))) {
        const t = html.match(/<title>([^<]+)<\/title>/i)?.[1];
        if (t) p.title = decodeEntities(t).split(/\s[|–—-]\s/)[0].trim();
      }
    }
    return toKnowledgeDoc({ kind: "page", handle: p.handle, title: p.title, url, text });
  })).filter((d) => d.chars >= MIN_TEXT_CHARS);
  return { docs, source, webFetches };
}

// ── Store chunks ──────────────────────────────────────────────────

async function storeDocs(shop, docs, config, log) {
  const embedding = resolveShopEmbedding(config);
  const rows = [];
  for (const d of docs) {
    let chunkIndex = 0;
    for (const s of splitSections(d.content)) {
      for (const c of chunkKnowledgeFile(s.text)) {
        const section = s.heading && s.heading !== d.title ? ` — ${s.heading}` : "";
        rows.push({
          shop,
          sourceFileId: `${STORE_SOURCE_PREFIX}${d.kind}:${d.handle}`,
          fileType: `store_${d.kind}`,
          sectionTitle: `${d.title}${section}`.slice(0, 250),
          chunkIndex: chunkIndex++,
          content: c.content,
        });
      }
    }
  }

  let vectors = null;
  if (embedding?.provider && embedding?.apiKey && rows.length > 0) {
    try {
      vectors = [];
      for (let i = 0; i < rows.length; i += 64) {
        const batch = rows.slice(i, i + 64).map((r) => `${r.sectionTitle}\n${r.content}`);
        vectors.push(...await embedTexts(embedding.provider, embedding.apiKey, batch, { inputType: "document" }));
      }
    } catch (err) {
      log(`[store-knowledge] embedding failed (chunks still stored for keyword search): ${err?.message || err}`);
      vectors = null;
    }
  }

  // Replace this shop's store-learned chunks only — uploaded files untouched.
  await prisma.knowledgeChunk.deleteMany({ where: { shop, sourceFileId: { startsWith: STORE_SOURCE_PREFIX } } });
  let embedded = 0;
  for (let i = 0; i < rows.length; i++) {
    const created = await prisma.knowledgeChunk.create({
      data: {
        ...rows[i],
        embeddingProvider: vectors ? embedding.provider : null,
        embeddingUpdatedAt: vectors ? new Date() : null,
      },
    });
    const v = vectors?.[i];
    if (Array.isArray(v) && v.length === EMBEDDING_DIMENSIONS) {
      try {
        await prisma.$executeRawUnsafe(`UPDATE "KnowledgeChunk" SET embedding = $1::vector WHERE id = $2`, vectorLiteral(v), created.id);
        embedded += 1;
      } catch (err) {
        log(`[store-knowledge] embedding write failed: ${err?.message || err}`);
      }
    }
  }
  storeChunkCache.delete(shop);
  return { chunks: rows.length, embedded };
}

export async function syncStoreKnowledge({ admin, shop, fetchImpl = fetch, log = (l) => console.log(l) }) {
  const started = Date.now();
  let domain = `https://${shop}`;
  try {
    const data = await gql(admin, `#graphql
      query { shop { primaryDomain { url } } }`);
    if (data?.shop?.primaryDomain?.url) domain = data.shop.primaryDomain.url.replace(/\/$/, "");
  } catch (err) {
    log(`[store-knowledge] domain lookup failed, using ${domain}: ${err.message}`);
  }

  const policies = await collectPolicies({ admin, domain, fetchImpl, log });
  const pages = await collectPages({ admin, domain, fetchImpl, log });
  const docs = [...policies.docs, ...pages.docs];
  if (docs.length === 0) {
    log(`[store-knowledge] ${shop}: nothing collected (policies=${policies.source} pages=${pages.source}) — keeping previous store knowledge`);
    return { ok: false, docs: 0, policiesSource: policies.source, pagesSource: pages.source };
  }
  const config = await getShopConfig(shop);
  const stored = await storeDocs(shop, docs, config, log);
  log(
    `[store-knowledge] ${shop}: docs=${docs.length} (policies=${policies.docs.length} via ${policies.source}, ` +
    `pages=${pages.docs.length} via ${pages.source}, web-fetches=${pages.webFetches || 0}) ` +
    `chunks=${stored.chunks} embedded=${stored.embedded} ms=${Date.now() - started}`,
  );
  return { ok: true, docs: docs.length, ...stored, policiesSource: policies.source, pagesSource: pages.source };
}

export function syncStoreKnowledgeAsync(args) {
  syncStoreKnowledge(args).catch((err) => console.error(`[store-knowledge] ${args?.shop} failed:`, err?.message || err));
}

// ── Read side ─────────────────────────────────────────────────────

const storeChunkCache = new Map(); // shop → { at, files }
const CACHE_MS = 5 * 60 * 1000;

async function storeChunksAsFiles(shop) {
  const hit = storeChunkCache.get(shop);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
  const rows = await prisma.knowledgeChunk.findMany({
    where: { shop, sourceFileId: { startsWith: STORE_SOURCE_PREFIX } },
    select: { fileType: true, sectionTitle: true, content: true },
    orderBy: [{ sourceFileId: "asc" }, { chunkIndex: "asc" }],
  });
  const files = rows.map((r) => ({ fileType: r.fileType, content: `${r.sectionTitle || ""}\n\n${r.content}` }));
  storeChunkCache.set(shop, { at: Date.now(), files });
  return files;
}

// Keyword search over store-learned knowledge (works with no embedding provider).
export async function lexicalStoreKnowledge(shop, query, { limit = 4 } = {}) {
  return lexicalRetrieveChunks(await storeChunksAsFiles(shop), query, { limit, minOverlap: 0.25 });
}

// Admin summary: one row per learned document.
export async function listStoreKnowledge(shop) {
  const rows = await prisma.knowledgeChunk.findMany({
    where: { shop, sourceFileId: { startsWith: STORE_SOURCE_PREFIX } },
    select: { sourceFileId: true, fileType: true, sectionTitle: true, content: true, chunkIndex: true, createdAt: true },
    orderBy: [{ sourceFileId: "asc" }, { chunkIndex: "asc" }],
  });
  const docs = new Map();
  for (const r of rows) {
    if (!docs.has(r.sourceFileId)) {
      docs.set(r.sourceFileId, {
        id: r.sourceFileId,
        kind: r.fileType === "store_policy" ? "Policy" : "Page",
        title: String(r.sectionTitle || "").split(" — ")[0],
        url: r.content.match(/Source:\s*(\S+)/)?.[1] || "",
        chunks: 0,
        chars: 0,
        syncedAt: r.createdAt,
      });
    }
    const d = docs.get(r.sourceFileId);
    d.chunks += 1;
    d.chars += r.content.length;
  }
  return [...docs.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
}
