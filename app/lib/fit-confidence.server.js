// Fit confidence — reads what each style's score is built from and keeps it,
// once a day (and on "Read now" in Smart Recommenders):
//  - reviewers' fit answers, from the store's Yotpo reviews;
//  - pairs sold and returned in the last 12 months, per product and size,
//    from Shopify's sales report (ShopifyQL, the read_reports permission);
//  - why pairs came back, from AfterShip returns — kept as items by kind of
//    reason (too small, too large…), with no shopper or order details.
// The scores reach every product card through the catalog (catalog.server.js).
// For a signed-in shopper, the sizes they kept (their own past orders, read
// live and never stored) give the card the score for their size.

import prisma from "../db.server.js";
import { ADMIN_API_VERSION } from "./admin-api-version.js";
import { AS_VERSION } from "./aftership.server.js";
import { nightlySyncPaused } from "./peak-mode.js";
import { normalizeProduct, productKind } from "./lean/catalog.js";
import { expandVariantSizes, normalizeOptionBag } from "./variant-matcher.server.js";
import {
  fitStyleKey, tallyReviewFit, returnReasonKind, emptyFitStats, fitBaselines,
  fitScore, fitScoreForSize, cardFit,
} from "./fit-confidence.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// The daily read skips a store read in the last 20 hours (a restart, a deploy).
const READ_EVERY_MS = 20 * 60 * 60 * 1000;
const RETURNS_DAYS = 365;
const RETURNS_WINDOW_DAYS = 7;
// Reviews: up to this many products of a style, and pages (of 150) each.
const YOTPO_PRODUCTS_PER_STYLE = 12;
const YOTPO_PAGES = 4;
const YOTPO_PER_PAGE = 150;
const SALES_LIMIT = 30000;

const numericId = (gid) => String(gid ?? "").match(/(\d+)\s*$/)?.[1] || "";
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZE_KEY = /^\d{1,2}(?:\.5)?$/;

// A size label ("9 - 9.5 US", "10.5 US") → the sizes it covers ("9", "9.5").
export function sizeKeys(label) {
  return expandVariantSizes(label).filter((k) => SIZE_KEY.test(k));
}

// A variant title from the sales report ("medium / 10.5 US", "9 - 9.5 US")
// → its sizes: the first part that has any.
export function titleSizeKeys(title) {
  for (const part of String(title || "").split("/")) {
    if (!/\d/.test(part)) continue;
    const keys = sizeKeys(part);
    if (keys.length) return keys;
  }
  return [];
}

// ── Shopify ───────────────────────────────────────────────────────────────

// A raw Admin API GraphQL call with the store's token (the chat's paths have
// no managed admin client).
export function tokenGraphql({ shop, accessToken, timeoutMs = 8000, fetchImpl = fetch }) {
  return async (query) => {
    const res = await fetchImpl(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw Object.assign(new Error(`Admin API ${res.status}`), { status: res.status });
    return res.json();
  };
}

// The managed admin client (admin pages, background jobs) as the same shape.
export const adminGraphql = (admin) => async (query) => {
  const resp = await admin.graphql(query);
  return resp.json();
};

// One ShopifyQL query → its rows ({ column: value }).
export async function shopifyql(graphql, ql) {
  const json = await graphql(`query { shopifyqlQuery(query: ${JSON.stringify(ql)}) { parseErrors tableData { rows } } }`);
  const data = json?.data?.shopifyqlQuery;
  if (json?.errors?.length || !data?.tableData) {
    const msg = String(json?.errors?.[0]?.message || data?.parseErrors?.[0] || "no report data");
    throw Object.assign(new Error(msg), { permission: /access|scope|permission|denied|read_reports/i.test(msg) });
  }
  return Array.isArray(data.tableData.rows) ? data.tableData.rows : [];
}

// Pairs ordered and returned in the last 12 months, per product and variant.
export async function readSales(graphql) {
  const rows = await shopifyql(graphql, `FROM sales SHOW quantity_ordered, quantity_returned GROUP BY product_id, product_variant_id SINCE -365d UNTIL today ORDER BY quantity_ordered DESC LIMIT ${SALES_LIMIT}`);
  return rows
    .map((r) => ({ productId: numericId(r.product_id), variantId: numericId(r.product_variant_id), ordered: Math.max(0, num(r.quantity_ordered)), returned: Math.abs(num(r.quantity_returned)) }))
    .filter((r) => r.productId && r.productId !== "0");
}

// ── Yotpo ─────────────────────────────────────────────────────────────────

async function yotpoPage(appKey, productId, page, fetchImpl) {
  const url = `https://api.yotpo.com/v1/widget/${encodeURIComponent(appKey)}/products/${encodeURIComponent(productId)}/reviews.json?per_page=${YOTPO_PER_PAGE}&page=${page}&sort=date&direction=desc`;
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw Object.assign(new Error(`Yotpo answered ${res.status}`), { status: res.status });
  const r = (await res.json())?.response || {};
  const reviews = Array.isArray(r.reviews) ? r.reviews : [];
  const perPage = num(r.pagination?.per_page) || YOTPO_PER_PAGE;
  return { reviews, more: page * perPage < num(r.pagination?.total) && reviews.length > 0 };
}

// A style's reviews, each once. Yotpo often groups a style's colors (every
// color shows all the style's reviews): a product whose first page brings no
// review not already read is in the same group, so its other pages are skipped.
// One product Yotpo can't answer for is skipped; if none answers, it throws.
export async function styleReviews(appKey, productIds, fetchImpl = fetch, counter = { requests: 0 }) {
  const byId = new Map();
  let answered = 0;
  let lastErr = null;
  for (const productId of productIds.slice(0, YOTPO_PRODUCTS_PER_STYLE)) {
    try {
      for (let page = 1; page <= YOTPO_PAGES; page++) {
        counter.requests++;
        const { reviews, more } = await yotpoPage(appKey, productId, page, fetchImpl);
        if (page === 1) answered++;
        let fresh = 0;
        for (const r of reviews) {
          const id = r?.id != null ? String(r.id) : "";
          if (id && byId.has(id)) continue;
          byId.set(id || `${productId}:${page}:${byId.size}`, r);
          fresh++;
        }
        if (!fresh || !more) break;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  if (!answered && lastErr) throw lastErr;
  return [...byId.values()];
}

// Runs `work` over `items`, `limit` at a time.
async function eachLimited(items, limit, work) {
  let i = 0;
  const run = async () => { while (i < items.length) { const item = items[i++]; await work(item); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

// ── AfterShip ─────────────────────────────────────────────────────────────

const isoSecond = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");

async function aftershipPage(apiKey, from, to, page, fetchImpl) {
  const qs = new URLSearchParams({ created_at_min: isoSecond(from), created_at_max: isoSecond(to), limit: "50", page: String(page) });
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(`https://api.aftership.com/returns/${AS_VERSION}/returns?${qs}`, {
      headers: { accept: "application/json", "as-api-key": apiKey },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429 && attempt < 4) {
      await sleep(Math.min(10_000, (num(res.headers?.get?.("retry-after")) || 2) * 1000));
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`AfterShip answered ${res.status}`), { status: res.status });
    const json = await res.json();
    const d = json?.data;
    return Array.isArray(d?.returns) ? d.returns : Array.isArray(d) ? d : Array.isArray(json?.returns) ? json.returns : [];
  }
}

// A return → its items, by kind of reason.
export function returnItems(ret) {
  const at = new Date(ret?.created_at || ret?.submitted_at || ret?.updated_at || 0);
  if (!Number.isFinite(at.getTime()) || at.getTime() <= 0) return [];
  const items = Array.isArray(ret?.return_items) ? ret.return_items : Array.isArray(ret?.items) ? ret.items : [];
  const out = [];
  items.forEach((it, i) => {
    const productId = numericId(it?.external_product_id ?? it?.product?.external_id ?? it?.product_id);
    if (!productId) return;
    const qty = Math.max(1, Math.round(num(it?.intended_return_quantity ?? it?.return_quantity ?? it?.quantity) || 1));
    out.push({
      id: String(it?.id || `${ret?.id || ""}:${i}`).slice(0, 120),
      productId,
      variantId: numericId(it?.external_variant_id ?? it?.variant?.external_id),
      kind: returnReasonKind(it?.return_reason ?? it?.reason, it?.return_subreason ?? it?.subreason),
      qty: Math.min(qty, 50),
      returnedAt: at,
    });
  });
  return out;
}

// New returns since the last read (the first time, the last 12 months), a
// week at a time, kept as items. Returns how far it got.
export async function syncAftershipReturns(shop, apiKey, { since = null, now = new Date(), fetchImpl = fetch, pauseMs = 150, onProgress = () => {} } = {}) {
  const end = now.getTime();
  const oldest = end - RETURNS_DAYS * DAY_MS;
  // Three days back from the last read: returns created then may have come in late.
  let from = Math.max(oldest, since ? new Date(since).getTime() - 3 * DAY_MS : oldest);
  let saved = 0;
  let truncated = false;
  const windows = Math.max(1, Math.ceil((end - from) / (RETURNS_WINDOW_DAYS * DAY_MS)));
  let done = 0;
  while (from < end) {
    const to = Math.min(end, from + RETURNS_WINDOW_DAYS * DAY_MS);
    for (let page = 1; page <= 200; page++) {
      const returns = await aftershipPage(apiKey, from, to, page, fetchImpl);
      const items = returns.flatMap(returnItems);
      if (items.length) {
        const r = await prisma.fitReturnItem.createMany({ data: items.map((it) => ({ shop, ...it })), skipDuplicates: true });
        saved += r.count;
      }
      if (returns.length < 50) break;
      if (page === 200) truncated = true;
      if (pauseMs) await sleep(pauseMs);
    }
    from = to;
    onProgress(++done, windows);
  }
  await prisma.fitReturnItem.deleteMany({ where: { shop, returnedAt: { lt: new Date(oldest) } } });
  return { syncedTo: new Date(end).toISOString(), saved, truncated };
}

// ── The read ──────────────────────────────────────────────────────────────

// The store's footwear and orthotics (drafts too: their sales and reviews
// count for the style) → styles, and each variant's sizes.
async function storeStyles(shop) {
  const rows = await prisma.product.findMany({
    where: { shop },
    select: { shopifyId: true, handle: true, title: true, productType: true, tags: true, status: true, attributesJson: true, variants: { select: { shopifyId: true, optionsJson: true } } },
  });
  const products = new Map(); // product id → { key, kind, active }
  const variants = new Map(); // variant id → size keys
  for (const row of rows) {
    const p = normalizeProduct({ ...row, variants: [] }, { shop });
    const kind = productKind(p);
    const key = fitStyleKey(p);
    const id = numericId(row.shopifyId);
    if (!key || !id || (kind !== "footwear" && kind !== "orthotic")) continue;
    products.set(id, { key, kind, name: p.style, active: !/^(draft|archived)$/i.test(String(row.status || "")) });
    for (const v of row.variants || []) {
      const bag = normalizeOptionBag(v.optionsJson);
      const sizeName = Object.keys(bag).find((k) => /^size$/i.test(k));
      const keys = sizeName ? sizeKeys(bag[sizeName]) : [];
      const vid = numericId(v.shopifyId);
      if (vid && keys.length) variants.set(vid, keys);
    }
  }
  return { products, variants };
}

// In plain words for the admin, never the raw error.
function sourceError(source, err) {
  const status = err?.status;
  if (source === "sales") return err?.permission ? "The app needs the reports permission (read_reports) — reinstall or update the app." : "Shopify's sales report didn't answer. Try again later.";
  if (source === "reviews") return status === 401 || status === 403 || status === 404 ? "Yotpo didn't accept the app key. Check it in Settings → Integrations." : "Yotpo didn't answer. Try again later.";
  return status === 401 || status === 403 ? "AfterShip refused the API key. Check it in Settings → Integrations." : "AfterShip didn't answer. Try again later.";
}

const running = new Map(); // shop → { startedAt, step, done, total }

export function fitRunState(shop) {
  const r = running.get(shop);
  return r ? { running: true, step: r.step, done: r.done, total: r.total, startedAt: r.startedAt } : { running: false };
}

// Reads everything and saves the scores. Each source can fail on its own;
// the others still count. `graphql`: Admin API caller (see adminGraphql).
export async function refreshFitData(shop, { graphql = null, config = {}, fetchImpl = fetch, now = new Date(), pauseMs = 150 } = {}) {
  if (running.has(shop)) return null;
  const run = { startedAt: Date.now(), step: "products", done: 0, total: 0 };
  running.set(shop, run);
  try {
    const prev = await prisma.fitData.findUnique({ where: { shop } });
    const status = { at: now.toISOString(), reviews: null, sales: null, returns: null, styles: 0 };
    const { products, variants } = await storeStyles(shop);
    const stats = new Map();
    const statsOf = (info) => {
      if (!stats.has(info.key)) stats.set(info.key, { ...emptyFitStats(), kind: info.kind, name: info.name });
      const s = stats.get(info.key);
      // The name as an active product spells it.
      if (info.active && info.name) s.name = info.name;
      return s;
    };
    for (const info of products.values()) statsOf(info);
    // A source that fails this time keeps the last read's numbers, so a day
    // Yotpo or Shopify doesn't answer doesn't move anyone's score.
    const prevStyles = prev?.data?.styles || {};
    const keepSales = () => {
      for (const [key, s] of stats) {
        const p = prevStyles[key];
        if (p) { s.sold = num(p.sold); s.returned = num(p.returned); s.sizes = JSON.parse(JSON.stringify(p.sizes || {})); }
      }
    };
    const keepReviews = (key) => {
      const p = prevStyles[key];
      const s = stats.get(key);
      if (p && s) { s.answered = num(p.answered); s.fits = num(p.fits); s.size = { ...emptyFitStats().size, ...p.size }; s.width = { ...emptyFitStats().width, ...p.width }; }
    };
    const KEPT = prev ? " The last read's numbers are kept until then." : "";

    // Sales and returns, per product and size.
    run.step = "sales";
    if (graphql) {
      try {
        const rows = await readSales(graphql);
        let sold = 0, returned = 0;
        for (const r of rows) {
          const info = products.get(r.productId);
          if (!info) continue;
          const s = statsOf(info);
          s.sold += r.ordered; s.returned += r.returned;
          sold += r.ordered; returned += r.returned;
          for (const k of variants.get(r.variantId) || []) {
            const z = s.sizes[k] || (s.sizes[k] = { sold: 0, returned: 0 });
            z.sold += r.ordered; z.returned += r.returned;
          }
        }
        status.sales = { ok: true, sold, returned, rows: rows.length, truncated: rows.length >= SALES_LIMIT };
      } catch (err) {
        console.error(`[fit] sales read failed shop=${shop}:`, err?.message || err);
        status.sales = { ok: false, error: sourceError("sales", err) + KEPT };
        keepSales();
      }
    } else {
      status.sales = { ok: false, error: `Shopify wasn't reachable for this read.${KEPT}` };
      keepSales();
    }

    // Reviewers' fit answers, per style.
    run.step = "reviews";
    if (config.yotpoApiKey) {
      const byStyle = new Map();
      for (const [id, info] of products) {
        if (!byStyle.has(info.key)) byStyle.set(info.key, []);
        byStyle.get(info.key).push({ id, active: info.active });
      }
      const counter = { requests: 0, failed: 0, styles: 0, answered: 0, reviews: 0, lastErr: null };
      const keys = [...byStyle.keys()];
      run.total = keys.length; run.done = 0;
      await eachLimited(keys, 4, async (key) => {
        const ids = byStyle.get(key).sort((a, b) => Number(b.active) - Number(a.active)).map((x) => x.id);
        try {
          const t = tallyReviewFit(await styleReviews(config.yotpoApiKey, ids, fetchImpl, counter));
          const s = stats.get(key);
          s.answered = t.answered; s.fits = t.fits; s.size = t.size; s.width = t.width;
          counter.reviews += t.reviews; counter.answered += t.answered;
          if (t.answered) counter.styles++;
        } catch (err) {
          counter.failed++; counter.lastErr = err;
          keepReviews(key);
        }
        run.done++;
      });
      const allFailed = keys.length > 0 && counter.failed === keys.length;
      if (allFailed) console.error(`[fit] reviews read failed shop=${shop}:`, counter.lastErr?.message || counter.lastErr);
      status.reviews = allFailed
        ? { ok: false, error: sourceError("reviews", counter.lastErr) + KEPT }
        : { ok: true, reviews: counter.reviews, answered: counter.answered, styles: counter.styles, failed: counter.failed };
    } else status.reviews = { ok: false, error: "Add the Yotpo app key in Settings → Integrations to use reviewers' fit answers." };

    // Why pairs came back.
    run.step = "returns"; run.done = 0; run.total = 0;
    let syncedTo = prev?.status?.returns?.syncedTo || null;
    if (config.aftershipApiKey) {
      try {
        const r = await syncAftershipReturns(shop, config.aftershipApiKey, {
          since: syncedTo, now, fetchImpl, pauseMs,
          onProgress: (done, total) => { run.done = done; run.total = total; },
        });
        syncedTo = r.syncedTo;
        status.returns = { ok: true, syncedTo, truncated: r.truncated };
      } catch (err) {
        console.error(`[fit] AfterShip read failed shop=${shop}:`, err?.message || err);
        status.returns = { ok: false, syncedTo, error: sourceError("returns", err) };
      }
    } else status.returns = { ok: false, syncedTo, error: "Add the AfterShip API key in Settings → Integrations to use return reasons." };
    const since = new Date(now.getTime() - RETURNS_DAYS * DAY_MS);
    const kinds = await prisma.fitReturnItem.groupBy({ by: ["productId", "kind"], where: { shop, returnedAt: { gte: since } }, _sum: { qty: true } });
    let items = 0, fitItems = 0;
    for (const g of kinds) {
      const info = products.get(g.productId);
      if (!info) continue;
      const n = num(g._sum?.qty);
      const s = statsOf(info);
      const kind = s.reasons[g.kind] != null ? g.kind : "other";
      s.reasons[kind] += n;
      items += n;
      if (kind !== "other") fitItems += n;
    }
    status.returns = { ...status.returns, items, fit: fitItems };

    // Scores.
    run.step = "scores";
    const base = fitBaselines([...stats.values()]);
    const styles = {};
    for (const [key, s] of stats) {
      const card = cardFit(fitScore(s, base[s.kind]));
      if (card) status.styles++;
      // A style with nothing read is left out.
      if (!s.sold && !s.answered && !Object.values(s.reasons).some(Boolean)) continue;
      const sizes = Object.fromEntries(Object.entries(s.sizes).filter(([, z]) => z.sold > 0));
      styles[key] = { ...s, sizes, card };
    }
    const pid = Object.fromEntries([...products].map(([id, info]) => [id, info.key]));
    const data = { v: 1, styles, base, pid };
    await prisma.fitData.upsert({
      where: { shop },
      update: { data, status, readAt: now },
      create: { shop, data, status, readAt: now },
    });
    cache.set(shop, { at: Date.now(), value: { data, status, readAt: now } });
    // The cards pick the new scores up now, not at the catalog's next reload.
    import("./lean/catalog.server.js").then((m) => m.reloadLeanCatalog(shop)).catch(() => {});
    console.log(`[fit] read shop=${shop} styles=${Object.keys(styles).length} scored=${status.styles} sales=${status.sales?.ok ? status.sales.sold : "x"} reviews=${status.reviews?.ok ? status.reviews.answered : "x"} returns=${status.returns?.ok ? status.returns.items : "x"} in ${Date.now() - run.startedAt}ms`);
    return { data, status };
  } finally {
    running.delete(shop);
  }
}

// The store's Admin API through its offline session (background reads
// outlive the page request that started them). null if it can't be reached.
async function shopGraphql(shop) {
  const { unauthenticated } = await import("../shopify.server");
  const admin = await unauthenticated.admin(shop).then((r) => r.admin).catch(() => null);
  return admin ? adminGraphql(admin) : null;
}

// Starts a read in the background (once per store at a time).
export function startFitRead(shop, { config = {}, graphql = null } = {}) {
  if (running.has(shop)) return false;
  (async () => refreshFitData(shop, { config, graphql: graphql || (await shopGraphql(shop)) }))()
    .catch((err) => console.error(`[fit] read failed shop=${shop}:`, err?.stack || err?.message || err));
  return true;
}

// ── Reading it back ───────────────────────────────────────────────────────

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // shop → { at, value }

// What was saved for the store: { data, status, readAt }, or null. Kept ten
// minutes per server.
export async function getFitData(shop) {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const row = await prisma.fitData.findUnique({ where: { shop } }).catch(() => null);
  const value = row ? { data: row.data, status: row.status, readAt: row.readAt } : null;
  cache.set(shop, { at: Date.now(), value });
  return value;
}

export function forgetFitData(shop) {
  cache.delete(shop);
}

// A style's card, worked out from what was read (so a change in what a card
// carries shows without waiting for the next read).
export function styleCard(data, key) {
  const s = data?.styles?.[key];
  return s ? cardFit(fitScore(s, data.base?.[s.kind] || {})) : null;
}

// The card's fit for a catalog product (null: not enough to say).
export function productFit(saved, p) {
  return styleCard(saved?.data, fitStyleKey(p));
}

// The daily read, for every store with fit confidence on. A store read in
// the last 20 hours, or in Peak Mode, is skipped.
export async function refreshAllFitData() {
  const configs = await prisma.shopConfig.findMany({ where: { fitConfidenceEnabled: true }, select: { shop: true } });
  for (const { shop } of configs) {
    try {
      const prev = await prisma.fitData.findUnique({ where: { shop }, select: { readAt: true } });
      if (prev && Date.now() - prev.readAt.getTime() < READ_EVERY_MS) continue;
      const hasProducts = await prisma.product.count({ where: { shop }, take: 1 });
      if (!hasProducts) continue;
      const { getShopConfig } = await import("../models/ShopConfig.server.js");
      const config = await getShopConfig(shop);
      // Peak Mode: nothing heavy in the background — the scores stay as last read.
      if (nightlySyncPaused(config)) {
        console.log(`[fit] ${shop}: Peak Mode is on — daily read skipped`);
        continue;
      }
      await refreshFitData(shop, { graphql: await shopGraphql(shop), config });
    } catch (err) {
      console.error(`[fit] daily read failed shop=${shop}:`, err?.message || err);
    }
  }
}

// ── A signed-in shopper's own sizes ───────────────────────────────────────

const shopperCache = new Map(); // shop:customer → { at, value }
const SHOPPER_MS = 10 * 60 * 1000;

// What the shopper bought in the last five years, per product and size, with
// how many they sent back. Read live for this chat, kept ten minutes in this
// server's memory only.
export async function shopperPurchases({ shop, customerId, graphql }) {
  const id = String(customerId ?? "").trim();
  if (!/^\d{1,20}$/.test(id) || !graphql) return null;
  const key = `${shop}:${id}`;
  const hit = shopperCache.get(key);
  if (hit && Date.now() - hit.at < SHOPPER_MS) return hit.value;
  const rows = await shopifyql(graphql, `FROM sales SHOW quantity_ordered, quantity_returned GROUP BY product_id, product_variant_title WHERE customer_id = ${id} SINCE -1825d UNTIL today ORDER BY quantity_ordered DESC LIMIT 500`);
  console.log(`[pii-access] shop=${shop} customer=${id} fields=purchased_sizes purpose=fit_confidence source=shopifyql`);
  const value = rows
    .map((r) => ({ productId: numericId(r.product_id), title: String(r.product_variant_title || ""), ordered: Math.max(0, num(r.quantity_ordered)), returned: Math.abs(num(r.quantity_returned)) }))
    .filter((r) => r.productId && r.ordered > 0);
  shopperCache.set(key, { at: Date.now(), value });
  if (shopperCache.size > 2000) shopperCache.delete(shopperCache.keys().next().value);
  return value;
}

// The shopper's sizes: the one they keep most per line (men's / women's
// shoes — only when it's at least half the pairs they kept in that line, so
// a family's mixed sizes don't count), and the size kept in each style.
export function shopperSizes(purchases = [], data = {}) {
  const lines = {};
  const kept = {};
  for (const r of purchases) {
    const key = data.pid?.[r.productId];
    const s = key ? data.styles?.[key] : null;
    if (!s || s.kind !== "footwear") continue;
    const line = key.split("|")[1];
    const pairs = r.ordered - Math.min(r.returned, r.ordered);
    const sizes = titleSizeKeys(r.title);
    if (!line || pairs <= 0 || !sizes.length) continue;
    const l = lines[line] || (lines[line] = { pairs: 0, counts: {} });
    l.pairs += pairs;
    for (const k of sizes) l.counts[k] = (l.counts[k] || 0) + pairs;
    if (!kept[key]) kept[key] = sizes[0];
  }
  const usual = {};
  for (const [line, l] of Object.entries(lines)) {
    const [top, n] = Object.entries(l.counts).sort((a, b) => b[1] - a[1])[0] || [];
    if (top && n * 2 >= l.pairs) usual[line] = top;
  }
  return { usual, kept };
}

// The card's fit in the shopper's own size, or null (no size known for that
// line, or too few pairs of it sold to say).
export function shopperFit(data, styleKey, sizes) {
  const s = data?.styles?.[styleKey];
  const line = String(styleKey || "").split("|")[1];
  if (!s || s.kind !== "footwear" || !line || !sizes) return null;
  const size = sizes.kept?.[styleKey] || sizes.usual?.[line];
  if (!size) return null;
  return cardFit(fitScoreForSize(s, size, data.base?.[s.kind] || {}));
}

// The chat's cards with the shopper's own fit where there is one. Waits for
// their purchases only so long; without them the cards keep the style's fit.
export async function withShopperFit(cards, { shop, catalog, purchases, waitMs = 1500 }) {
  if (!purchases || !Array.isArray(cards) || !cards.length) return cards;
  const [saved, bought] = await Promise.all([
    getFitData(shop),
    Promise.race([purchases.catch(() => null), sleep(waitMs).then(() => null)]),
  ]);
  if (!saved?.data || !bought?.length) return cards;
  const sizes = shopperSizes(bought, saved.data);
  if (!Object.keys(sizes.usual).length && !Object.keys(sizes.kept).length) return cards;
  const byHandle = new Map((catalog?.products || []).map((p) => [p.handle, p]));
  return cards.map((c) => {
    const p = byHandle.get(c.handle);
    const mine = p && c.fit ? shopperFit(saved.data, fitStyleKey(p), sizes) : null;
    return mine ? { ...c, fit: mine } : c;
  });
}

// ── For the admin ─────────────────────────────────────────────────────────

const LINE_NAMES = { m: "Men's", w: "Women's" };

// What the last read found, for Smart Recommenders → Fit confidence: each
// source's counts (or its error), and the styles with the lowest scores.
export async function fitSummary(shop) {
  const saved = await getFitData(shop);
  const styles = Object.entries(saved?.data?.styles || {});
  const scored = styles
    .map(([key, s]) => ({ key, s, card: styleCard(saved.data, key) }))
    .filter((x) => x.card)
    .map(({ key, s, card }) => ({ key, name: s.name || key.split("|")[0], line: LINE_NAMES[key.split("|")[1]] || "", kind: s.kind, ...card }));
  scored.sort((a, b) => a.s - b.s || b.n - a.n);
  return {
    readAt: saved?.readAt ? new Date(saved.readAt).toISOString() : null,
    status: saved?.status || null,
    scored: scored.length,
    lowest: scored.slice(0, 5),
    run: fitRunState(shop),
  };
}

// A read is due when there's none yet or the last is over a day old (the
// daily job missed it).
export function fitReadDue(summary) {
  if (!summary?.readAt) return true;
  return Date.now() - new Date(summary.readAt).getTime() > 26 * 60 * 60 * 1000;
}
