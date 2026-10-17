// Product webhooks (create/update): dedupe, coalesce and drain in the
// background so Shopify gets its 200 at once.
import { upsertProductFromWebhook, syncCatalog } from "../models/Product.server";
import { getShopConfig } from "../models/ShopConfig.server";
import { resolveShopEmbedding, embedAndStoreProducts } from "./embeddings.server";
import prisma from "../db.server";

// ── Webhook storm handling ─────────────────────────────────────────
//
// Shopify fires PRODUCTS_UPDATE per product. A bulk operation on the
// store (re-tagging, an inventory app, a feed sync) touches the whole
// catalog and produces hundreds of webhooks in seconds, then a trickle
// for many minutes. Live trace 2026-06-10 16:50: ~150 distinct
// products in 25s. Each webhook used to cost a DB query + a Shopify
// GraphQL fetch + a multi-row upsert + an embedding API call — run
// concurrently that has caused Postgres "too many clients" FATALs and
// embedding-provider failures ("[embeddings] batch failed").
//
// Three layers of defense, all in-memory (single-instance app):
//
//  1. DEDUP — repeats of the SAME product within 30s are dropped
//     outright (covers Shopify's at-least-once redelivery and rapid
//     consecutive edits to one product).
//
//  2. COALESCE — the request handler only enqueues the product id and
//     acks 200 immediately. A drain runs DEBOUNCE_MS later and
//     processes the batch with limited concurrency, batching the
//     embedding calls instead of one API call per product.
//
//  3. CIRCUIT BREAKER — when one drain batch holds ≥ FULL_SYNC_THRESHOLD
//     distinct products, that's a bulk catalog operation: one paginated
//     full sync is far cheaper than N single-product GraphQL fetches.
//     syncCatalog sets catalogSyncState.status="running", which makes
//     the drains for the rest of the storm no-ops until it finishes.
//
// Trade-off: a product change can be up to ~DEBOUNCE_MS + drain time
// stale in chat. Search/RAG doesn't need second-by-second freshness.

const RECENT_WEBHOOKS = new Map(); // key=`${shop}:${productId}` → ms
const DEDUP_WINDOW_MS = 30_000;
const MAX_ENTRIES = 5000;

const DEBOUNCE_MS = 8_000;
const DRAIN_CONCURRENCY = 3;
const FULL_SYNC_THRESHOLD = 40;
const SYNC_RETRY_MS = 60_000;

const QUEUES = new Map(); // shop → { ids:Set<number|string>, timer, admin, draining }

function shouldDedupe(shop, productId) {
  const key = `${shop}:${productId}`;
  const now = Date.now();
  const last = RECENT_WEBHOOKS.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return true;
  RECENT_WEBHOOKS.set(key, now);
  if (RECENT_WEBHOOKS.size > MAX_ENTRIES) {
    const cutoff = now - DEDUP_WINDOW_MS;
    for (const [k, t] of RECENT_WEBHOOKS) {
      if (t < cutoff) RECENT_WEBHOOKS.delete(k);
    }
  }
  return false;
}

async function drainQueue(shop) {
  const q = QUEUES.get(shop);
  if (!q) return;
  q.timer = null;
  if (q.draining) return;
  q.draining = true;

  try {
    // A full sync (manual or breaker-triggered) is already rebuilding
    // the catalog — these queued updates will be covered by it.
    const syncState = await prisma.catalogSyncState
      .findUnique({ where: { shop } })
      .catch(() => null);
    if (syncState?.status === "running") {
      // Keep the ids: the sync may already be past these products.
      // Try again once it has had time to finish.
      q.retryLater = true;
      return;
    }

    const ids = Array.from(q.ids);
    q.ids.clear();
    const admin = q.admin;
    if (!admin || ids.length === 0) return;

    if (ids.length >= FULL_SYNC_THRESHOLD) {
      console.log(
        `[webhook PRODUCTS_UPDATE] ${shop}: ${ids.length} distinct products in one burst — ` +
          `bulk operation detected, running ONE full catalog sync instead of ${ids.length} single fetches`,
      );
      try {
        await syncCatalog(admin, shop);
      } catch (err) {
        console.error(`[webhook PRODUCTS_UPDATE] full sync failed:`, err?.message || err);
      }
      // Fall through to re-embed the touched products below (the full
      // sync refreshes rows but does not recompute embeddings).
    } else {
      console.log(
        `[webhook PRODUCTS_UPDATE] ${shop}: draining ${ids.length} coalesced update(s)`,
      );
      let next = 0;
      const worker = async () => {
        while (next < ids.length) {
          const id = ids[next++];
          try {
            await upsertProductFromWebhook(shop, { id }, admin);
          } catch (err) {
            console.error(`[webhook PRODUCTS_UPDATE] upsert ${id} failed:`, err?.message || err);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DRAIN_CONCURRENCY, ids.length) }, worker),
      );
    }

    // One batched embedding pass for the whole drain instead of one
    // background API call per product.
    try {
      const config = await getShopConfig(shop).catch(() => null);
      const resolved = config ? resolveShopEmbedding(config) : null;
      if (resolved) {
        const gids = ids.map((id) =>
          typeof id === "string" && id.startsWith("gid://")
            ? id
            : `gid://shopify/Product/${id}`,
        );
        const rows = await prisma.product.findMany({
          where: { shop, shopifyId: { in: gids } },
          select: {
            id: true,
            title: true,
            vendor: true,
            productType: true,
            tags: true,
            description: true,
            attributesJson: true,
          },
        });
        if (rows.length > 0) {
          // Provider-safe chunks (same 50 limit the backfill uses).
          for (let i = 0; i < rows.length; i += 50) {
            await embedAndStoreProducts(
              prisma,
              resolved.provider,
              resolved.apiKey,
              rows.slice(i, i + 50),
            );
          }
        }
      }
    } catch (err) {
      console.error(`[webhook PRODUCTS_UPDATE] batch embed failed:`, err?.message || err);
    }
  } finally {
    q.draining = false;
    // Webhooks that arrived mid-drain (or held for a running sync) are
    // waiting — schedule the next pass.
    if (q.ids.size > 0 && !q.timer) {
      const wait = q.retryLater ? SYNC_RETRY_MS : DEBOUNCE_MS;
      q.retryLater = false;
      q.timer = setTimeout(() => drainQueue(shop), wait);
    }
  }
}

// products/create and products/update both land here: the handler acks
// at once and the product is fetched and saved in the background.
export function enqueueProductChange(shop, productId, admin) {
  if (!productId || !admin) return;
  if (shouldDedupe(shop, productId)) return;
  let q = QUEUES.get(shop);
  if (!q) {
    q = { ids: new Set(), timer: null, admin: null, draining: false, retryLater: false };
    QUEUES.set(shop, q);
  }
  q.ids.add(productId);
  q.admin = admin; // keep the freshest client for the drain
  if (!q.timer && !q.draining) {
    q.timer = setTimeout(() => drainQueue(shop), DEBOUNCE_MS);
  }
}
