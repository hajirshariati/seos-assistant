// Store knowledge — learn the store from its own website, automatically.
//
// Reads everything the store publishes — policies (refund, shipping, terms,
// privacy, contact), every published page (shipping, FAQ, about, clinical
// studies, technologies…) and every published blog article — and stores it
// as knowledge chunks the chat already searches, so the merchant never has
// to re-upload what's on their site. Uploaded knowledge files stay the
// override: they're labelled as the store team's notes and win on conflict.
//
// Admin API first (needs read_legal_policies / read_content); if the app
// doesn't have those yet, the public storefront (policy pages + sitemap) is
// used instead. Theme-built pages with an empty body are read from the
// theme's page template (read_themes), else from the live page. Runs after
// every catalog sync and from the Knowledge page; unchanged chunks keep their
// embeddings, so a re-sync only pays to embed what changed.

import prisma from "../../db.server.js";
import { getShopConfig } from "../../models/ShopConfig.server.js";
import { chunkKnowledgeFile, lexicalRetrieveChunks } from "../knowledge-chunks.server.js";
import { embedTexts, vectorLiteral, resolveShopEmbedding, EMBEDDING_DIMENSIONS } from "../embeddings.server.js";
import { decodeEntities, htmlToText, parseSitemap, parseThemeJson, POLICY_SLUGS, splitSections, themeTemplateText, toKnowledgeDoc } from "./extract.js";

export const STORE_SOURCE_PREFIX = "store:";
const MIN_TEXT_CHARS = 120;
const THIN_BODY_CHARS = 300;
const MAX_PAGES = 500;
const MAX_ARTICLES = 2000;
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

// Text of the main theme's page templates (templates/page.<suffix>.json),
// keyed by lower-case suffix. Empty when the app can't read themes.
async function themePageTemplates(admin, suffixes, domain, log) {
  const out = new Map();
  const wanted = [...new Set(suffixes.filter(Boolean).map((x) => String(x).toLowerCase()))];
  if (wanted.length === 0) return out;
  try {
    const data = await gql(admin, `#graphql
      query { themes(first: 1, roles: [MAIN]) { nodes { id } } }`);
    const themeId = data?.themes?.nodes?.[0]?.id;
    if (!themeId) return out;
    for (let i = 0; i < wanted.length; i += 50) {
      const filenames = wanted.slice(i, i + 50).map((x) => `templates/page.${x}.json`);
      const res = await gql(admin, `#graphql
        query ThemePages($id: ID!, $filenames: [String!]) {
          theme(id: $id) {
            files(filenames: $filenames, first: 50) {
              nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } }
            }
          }
        }`, { id: themeId, filenames });
      for (const f of res?.theme?.files?.nodes || []) {
        const suffix = String(f.filename || "").toLowerCase().match(/^templates\/page\.(.+)\.json$/)?.[1];
        const text = themeTemplateText(parseThemeJson(f.body?.content), { domain });
        if (suffix && text) out.set(suffix, text);
      }
    }
  } catch (err) {
    if (!err.accessDenied) log(`[store-knowledge] theme templates failed: ${err.message}`);
  }
  return out;
}

async function collectPages({ admin, domain, ownHosts, fetchImpl, log }) {
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
            nodes { title handle body isPublished templateSuffix }
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

  // Theme-built pages keep their content in sections, not the body: read
  // the theme template first (no network, exactly what the merchant wrote),
  // then the live page.
  const thin = pages.filter((p) => htmlToText(p.body).length < THIN_BODY_CHARS);
  const templates = source === "admin" ? await themePageTemplates(admin, thin.map((p) => p.templateSuffix), domain, log) : new Map();
  let webFetches = 0;
  let fromTheme = 0;
  const docs = (await mapLimit(pages, 4, async (p) => {
    const url = p.url || `${domain}/pages/${p.handle}`;
    let text = htmlToText(p.body, { ownHosts });
    const tpl = p.templateSuffix ? templates.get(String(p.templateSuffix).toLowerCase()) : "";
    if (text.length < THIN_BODY_CHARS && tpl && tpl.length > text.length) {
      text = [text, tpl].filter(Boolean).join("\n\n");
      fromTheme += 1;
    }
    if (text.length < THIN_BODY_CHARS) {
      webFetches += 1;
      const html = await fetchText(url, fetchImpl);
      const live = html ? htmlToText(html, { ownHosts }) : "";
      if (live.length > text.length) text = live;
      if (html && (!p.title || p.title === titleFromSlug(p.handle))) {
        const t = html.match(/<title>([^<]+)<\/title>/i)?.[1];
        if (t) p.title = decodeEntities(t).split(/\s[|–—-]\s/)[0].trim();
      }
    }
    return toKnowledgeDoc({ kind: "page", handle: p.handle, title: p.title, url, text });
  })).filter((d) => d.chars >= MIN_TEXT_CHARS);
  return { docs, source, webFetches, fromTheme };
}

async function collectArticles({ admin, domain, ownHosts, log }) {
  const docs = [];
  try {
    let after = null;
    let seen = 0;
    while (seen < MAX_ARTICLES) {
      const data = await gql(admin, `#graphql
        query Articles($after: String) {
          articles(first: 100, after: $after, sortKey: PUBLISHED_AT, reverse: true) {
            pageInfo { hasNextPage endCursor }
            nodes { title handle body summary isPublished publishedAt tags blog { handle title } }
          }
        }`, { after });
      const conn = data?.articles;
      for (const a of conn?.nodes || []) {
        seen += 1;
        if (a.isPublished === false || !a.blog?.handle) continue;
        const date = a.publishedAt ? String(a.publishedAt).slice(0, 10) : "";
        const meta = [`${a.blog.title || titleFromSlug(a.blog.handle)} article`, date && `published ${date}`, a.tags?.length && `topics: ${a.tags.join(", ")}`].filter(Boolean).join(" · ");
        const text = [meta, htmlToText(a.summary, { ownHosts }), htmlToText(a.body, { ownHosts })].filter(Boolean).join("\n\n");
        docs.push(toKnowledgeDoc({ kind: "article", handle: `${a.blog.handle}/${a.handle}`, title: a.title, url: `${domain}/blogs/${a.blog.handle}/${a.handle}`, text }));
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
  } catch (err) {
    if (!err.accessDenied) log(`[store-knowledge] articles via admin failed: ${err.message}`);
    return { docs: [], source: "none" };
  }
  return { docs: docs.filter((d) => d.chars >= MIN_TEXT_CHARS), source: "admin" };
}

// ── Store chunks ──────────────────────────────────────────────────

async function storeDocs(shop, docs, config, log, { preserve = [] } = {}) {
  const embedding = resolveShopEmbedding(config);
  const rows = [];
  for (const d of docs) {
    let chunkIndex = 0;
    for (const s of splitSections(d.content)) {
      for (const c of chunkKnowledgeFile(s.text)) {
        const section = s.heading && s.heading !== d.title ? ` — ${s.heading}` : "";
        // Every chunk names its page, so an answer can always link to it.
        const content = d.url && !c.content.includes(`Source: ${d.url}`) ? `Source: ${d.url}\n${c.content}` : c.content;
        rows.push({
          shop,
          sourceFileId: `${STORE_SOURCE_PREFIX}${d.kind}:${d.handle}`,
          fileType: `store_${d.kind}`,
          sectionTitle: `${d.title}${section}`.slice(0, 250),
          chunkIndex: chunkIndex++,
          content,
        });
      }
    }
  }

  // Keep chunks that haven't changed (and are embedded with the current
  // provider, if there is one); replace the rest. Uploaded files untouched.
  const key = (r) => `${r.sourceFileId}\u0000${r.chunkIndex}\u0000${r.sectionTitle}\u0000${r.content}`;
  const existing = await prisma.knowledgeChunk.findMany({
    where: { shop, sourceFileId: { startsWith: STORE_SOURCE_PREFIX } },
    select: { id: true, sourceFileId: true, chunkIndex: true, sectionTitle: true, content: true, embeddingProvider: true },
  });
  const wantEmbedding = Boolean(embedding?.provider && embedding?.apiKey);
  let embeddedIds = new Set();
  if (wantEmbedding && existing.length) {
    try {
      const got = await prisma.$queryRawUnsafe(
        `SELECT id FROM "KnowledgeChunk" WHERE shop = $1 AND "sourceFileId" LIKE $2 AND embedding IS NOT NULL`,
        shop, `${STORE_SOURCE_PREFIX}%`,
      );
      embeddedIds = new Set((got || []).map((r) => r.id));
    } catch {
      embeddedIds = new Set();
    }
  }
  const keep = new Map();
  for (const e of existing) {
    const current = !wantEmbedding || (e.embeddingProvider === embedding.provider && embeddedIds.has(e.id));
    if (current && !keep.has(key(e))) keep.set(key(e), e.id);
  }
  const fresh = rows.filter((r) => !keep.has(key(r)));
  const rowKeys = new Set(rows.map(key));
  const keepIds = new Set([...keep.entries()].filter(([k]) => rowKeys.has(k)).map(([, id]) => id));
  // A source that couldn't be read this time (e.g. articles) keeps what it had.
  const preserved = (e) => preserve.some((prefix) => e.sourceFileId.startsWith(prefix));
  const stale = existing.filter((e) => !keepIds.has(e.id) && !preserved(e)).map((e) => e.id);

  let vectors = null;
  if (wantEmbedding && fresh.length > 0) {
    try {
      vectors = [];
      for (let i = 0; i < fresh.length; i += 64) {
        const batch = fresh.slice(i, i + 64).map((r) => `${r.sectionTitle}\n${r.content}`);
        vectors.push(...await embedTexts(embedding.provider, embedding.apiKey, batch, { inputType: "document" }));
      }
    } catch (err) {
      log(`[store-knowledge] embedding failed (chunks still stored for keyword search): ${err?.message || err}`);
      vectors = null;
    }
  }

  for (let i = 0; i < stale.length; i += 500) {
    await prisma.knowledgeChunk.deleteMany({ where: { shop, id: { in: stale.slice(i, i + 500) } } });
  }
  let embedded = 0;
  for (let i = 0; i < fresh.length; i++) {
    const created = await prisma.knowledgeChunk.create({
      data: {
        ...fresh[i],
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
  return { chunks: rows.length, added: fresh.length, removed: stale.length, kept: keepIds.size, embedded };
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

  const ownHosts = [new URL(domain).hostname, shop];
  const policies = await collectPolicies({ admin, domain, fetchImpl, log });
  const pages = await collectPages({ admin, domain, ownHosts, fetchImpl, log });
  const articles = await collectArticles({ admin, domain, ownHosts, log });
  const docs = [...policies.docs, ...pages.docs, ...articles.docs];
  if (docs.length === 0) {
    log(`[store-knowledge] ${shop}: nothing collected (policies=${policies.source} pages=${pages.source}) — keeping previous store knowledge`);
    return { ok: false, docs: 0, policiesSource: policies.source, pagesSource: pages.source };
  }
  const config = await getShopConfig(shop);
  const stored = await storeDocs(shop, docs, config, log, {
    preserve: articles.source === "none" ? [`${STORE_SOURCE_PREFIX}article:`] : [],
  });
  log(
    `[store-knowledge] ${shop}: docs=${docs.length} (policies=${policies.docs.length} via ${policies.source}, ` +
    `pages=${pages.docs.length} via ${pages.source}, from-theme=${pages.fromTheme || 0}, web-fetches=${pages.webFetches || 0}, ` +
    `articles=${articles.docs.length}) chunks=${stored.chunks} (+${stored.added} −${stored.removed}) embedded=${stored.embedded} ms=${Date.now() - started}`,
  );
  return { ok: true, docs: docs.length, ...stored, policiesSource: policies.source, pagesSource: pages.source, articles: articles.docs.length };
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

const KIND_LABELS = { store_policy: "Policy", store_page: "Page", store_article: "Article" };

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
        kind: KIND_LABELS[r.fileType] || "Page",
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
