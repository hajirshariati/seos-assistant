import prisma from "../db.server";
import { nightlySyncPaused } from "./peak-mode.js";

// Nightly catalog reconciliation. Webhooks keep the catalog current in
// real time (single updates within seconds, bulk edits via the 40+
// circuit breaker), but webhook delivery is not guaranteed — Shopify
// recommends a periodic reconciliation job. This scheduler runs ONE
// full catalog sync per shop every night at SYNC_HOUR_UTC, staggered
// 30s apart so multiple shops don't hammer the API together.
//
// syncCatalog claims the shop's sync atomically, so an overlapping manual
// or webhook-triggered sync steps aside instead of running twice.
// Set DISABLE_CATALOG_SYNC_SCHEDULER=true to turn the nightly run off. A
// store in Peak Mode (Settings) sits it out by default.
//
// 09:00 UTC is 4-5 AM in New York and 1-2 AM in Los Angeles: the quietest
// hour for US shoppers (03:00 UTC was the evening peak on the West Coast).

export const SYNC_HOUR_UTC = 9;
// A sync whose state row hasn't moved for this long is dead.
const STALE_RUNNING_MS = 10 * 60 * 1000;

export function nextScheduledSyncAt(now = Date.now()) {
  const d = new Date(now);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), SYNC_HOUR_UTC, 0, 0));
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

let started = false;

export function startCatalogSyncScheduler() {
  if (started) return;
  if (String(process.env.DISABLE_CATALOG_SYNC_SCHEDULER || "").toLowerCase() === "true") {
    console.log("[sync-scheduler] disabled via DISABLE_CATALOG_SYNC_SCHEDULER");
    return;
  }
  started = true;

  // A deploy/restart kills any in-flight sync, leaving its state stuck on
  // "running" forever (the process that owned it is gone). A live sync
  // updates its row as it goes, so one that hasn't moved for a while is
  // dead — flag it as interrupted so the admin shows the truth and the
  // nightly run (or a manual refresh) takes it from there. A sync another
  // server is still running is left alone.
  prisma.catalogSyncState
    .updateMany({
      where: { status: { in: ["running", "stopping"] }, updatedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
      data: {
        status: "error",
        lastError: "Sync interrupted by a server restart — it will retry at the next nightly run, or use Refresh on the Catalog page.",
      },
    })
    .then((r) => {
      if (r.count > 0) console.log(`[sync-scheduler] reset ${r.count} sync(s) stuck in 'running' after restart`);
    })
    .catch(() => {});

  const runAll = async () => {
    try {
      // Dynamic imports avoid a module cycle: shopify.server starts this
      // scheduler at boot, and we only need shopify.server at run time.
      const { unauthenticated } = await import("../shopify.server");
      const { syncCatalogAsync } = await import("../models/Product.server");
      const shops = await prisma.session.findMany({
        where: { isOnline: false },
        select: { shop: true },
        distinct: ["shop"],
      });
      console.log(`[sync-scheduler] nightly reconciliation: ${shops.length} shop(s)`);
      for (const { shop } of shops) {
        const config = await prisma.shopConfig.findUnique({ where: { shop }, select: { peakMode: true, peakStartsAt: true, peakEndsAt: true, peakPauseSync: true } }).catch(() => null);
        if (config && nightlySyncPaused(config)) {
          console.log(`[sync-scheduler] ${shop}: Peak Mode is on — nightly sync skipped (product changes still sync live)`);
          continue;
        }
        try {
          const { admin } = await unauthenticated.admin(shop);
          syncCatalogAsync(admin, shop);
        } catch (err) {
          console.error(`[sync-scheduler] ${shop}:`, err?.message || err);
        }
        // Stagger shop starts so concurrent full syncs don't pile up.
        await new Promise((r) => setTimeout(r, 30_000));
      }
    } catch (err) {
      console.error("[sync-scheduler] run failed:", err?.message || err);
    }
  };

  const arm = () => {
    const delay = nextScheduledSyncAt().getTime() - Date.now();
    console.log(
      `[sync-scheduler] next nightly catalog sync in ${(delay / 3_600_000).toFixed(1)}h (${String(SYNC_HOUR_UTC).padStart(2, "0")}:00 UTC)`,
    );
    const t = setTimeout(() => {
      runAll().finally(arm);
    }, delay);
    if (typeof t.unref === "function") t.unref();
  };
  arm();
}
