// Product webhooks (create/update): dedupe, coalesce and drain in the
// background so Shopify gets its 200 at once.
import { upsertProductFromWebhook, syncCatalog } from "../models/Product.server";
import prisma from "../db.server";

// ── Webhook storm handling ─────────────────────────────────────────
//
// Shopify fires PRODUCTS_UPDATE per product. A bulk operation on the
// store (re-tagging, an inventory app, a feed sync) touches the whole
// catalog and produces hundreds of webhooks in seconds, then a trickle
// for many minutes. Live trace 2026-06-10 16:50: ~150 distinct
// products in 25s. Each webhook used to cost a DB query + a Shopify
// GraphQL fetch + a multi-row upsert (and, until it was dropped, an
// embedding API call) — run concurrently that caused Postgres "too many
// clients" FATALs. Product embeddings aren't computed here any more: the
// chat searches the catalog in memory and never reads them, and on a busy
// sale day every order's stock change would re-embed the product.
//
// Three layers of defense, all in-memory (single-instance app):
//
//  1. DEDUP — repeats of the SAME product within 30s are dropped
//     outright (covers Shopify's at-least-once redelivery and rapid
//     consecutive edits to one product).
//
//  2. COALESCE — the request handler only enqueues the product id and
//     acks 200 immediately. A drain runs DEBOUNCE_MS later and
//     processes the batch with limited concurrency.
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
            // Shopify's API was busy: keep the product for the next pass
            // instead of losing the change until the nightly sync.
            if (err?.code === "THROTTLED") { q.ids.add(id); q.retryLater = true; continue; }
            console.error(`[webhook PRODUCTS_UPDATE] upsert ${id} failed:`, err?.message || err);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DRAIN_CONCURRENCY, ids.length) }, worker),
      );
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
