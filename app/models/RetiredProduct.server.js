import prisma from "../db.server";
import { retiredRowFromProduct, DAY_MS } from "../lib/memory.js";

// Memory of products that left the store (see app/lib/memory.js).

export const MAX_KEEP_DAYS = 1100;
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // shop → { at, rows }

// Products about to go (deleted) or just hidden (archived, draft): one row
// each, kept open until the product is active again. A row already open
// keeps its first date; a closed one reopens with today's.
export async function retireProducts(shop, rows = [], reason = "archived", now = new Date()) {
  if (!shop || !rows.length) return 0;
  const data = rows.map((r) => retiredRowFromProduct(r, reason)).filter((d) => d.shopifyId && d.handle);
  if (!data.length) return 0;
  const open = new Map((await prisma.retiredProduct.findMany({ where: { shop, returnedAt: null, shopifyId: { in: data.map((d) => d.shopifyId) } }, select: { id: true, shopifyId: true, reason: true } })).map((r) => [r.shopifyId, r]));
  const ops = [];
  let n = 0;
  for (const d of data) {
    const existing = open.get(d.shopifyId);
    if (existing) {
      // Still gone; a delete after an archive is still "gone" — the first date stays, the stronger reason is noted.
      if (reason === "deleted" && existing.reason !== "deleted") ops.push(prisma.retiredProduct.update({ where: { id: existing.id }, data: { reason: "deleted" } }));
      continue;
    }
    ops.push(prisma.retiredProduct.upsert({
      where: { shop_shopifyId: { shop, shopifyId: d.shopifyId } },
      update: { ...d, retiredAt: now, returnedAt: null },
      create: { shop, ...d, retiredAt: now },
    }));
    n += 1;
  }
  for (let i = 0; i < ops.length; i += 200) await prisma.$transaction(ops.slice(i, i + 200));
  if (n) { cache.delete(shop); console.log(`[memory] ${shop}: ${n} product(s) retired (${reason})`); }
  return n;
}

// Products active again: their open rows close.
export async function unretireProducts(shop, shopifyIds = [], now = new Date()) {
  if (!shop || !shopifyIds.length) return 0;
  const { count } = await prisma.retiredProduct.updateMany({ where: { shop, returnedAt: null, shopifyId: { in: shopifyIds } }, data: { returnedAt: now } });
  if (count) { cache.delete(shop); console.log(`[memory] ${shop}: ${count} product(s) back in the store`); }
  return count;
}

// The open rows within the window, cached a few minutes per store (small).
export async function getRetiredProducts(shop, { days = 730, now = Date.now() } = {}) {
  if (!shop) return [];
  const hit = cache.get(shop);
  if (hit && now - hit.at < CACHE_MS && hit.days === days) return hit.rows;
  const rows = await prisma.retiredProduct.findMany({
    where: { shop, returnedAt: null, retiredAt: { gte: new Date(now - days * DAY_MS) } },
    orderBy: { retiredAt: "desc" },
    take: 5000,
  });
  cache.set(shop, { at: now, days, rows });
  return rows;
}

export async function listRetiredProducts(shop, { days = 730, take = 300 } = {}) {
  if (!shop) return [];
  return prisma.retiredProduct.findMany({ where: { shop, retiredAt: { gte: new Date(Date.now() - days * DAY_MS) } }, orderBy: { retiredAt: "desc" }, take });
}

export async function cleanupOldRetiredProducts() {
  const cutoff = new Date(Date.now() - MAX_KEEP_DAYS * DAY_MS);
  const { count } = await prisma.retiredProduct.deleteMany({ where: { retiredAt: { lt: cutoff } } });
  if (count > 0) console.log(`[memory] removed ${count} retired product(s) older than ${MAX_KEEP_DAYS} days`);
  return count;
}

export const clearRetiredCache = () => cache.clear();
