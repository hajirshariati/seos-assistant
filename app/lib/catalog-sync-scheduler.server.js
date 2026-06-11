import prisma from "../db.server";

// Nightly catalog reconciliation. Webhooks keep the catalog current in
// real time (single updates within seconds, bulk edits via the 40+
// circuit breaker), but webhook delivery is not guaranteed — Shopify
// recommends a periodic reconciliation job. This scheduler runs ONE
// full catalog sync per shop every night at SYNC_HOUR_UTC, staggered
// 30s apart so multiple shops don't hammer the API together.
//
// syncCatalog itself sets status=running at start, so an overlapping
// manual sync or webhook-triggered full sync simply no-ops the extras.
// Set DISABLE_CATALOG_SYNC_SCHEDULER=true to turn the nightly run off.

export const SYNC_HOUR_UTC = 3;

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
  // "running" forever (the process that owned it is gone). One instance
  // serves the app, so at boot anything still marked running is dead —
  // flag it as interrupted so the admin shows the truth and the nightly
  // run (or a manual refresh) takes it from there.
  prisma.catalogSyncState
    .updateMany({
      where: { status: { in: ["running", "stopping"] } },
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
