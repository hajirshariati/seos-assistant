import prisma from "../db.server";
import { dayKeyIn, dayKeysBetween } from "../lib/store-day.js";

function resolveRange(arg) {
  if (arg && typeof arg === "object" && arg.startDate && arg.endDate) {
    return { start: new Date(arg.startDate), end: new Date(arg.endDate) };
  }
  const days = typeof arg === "number" ? arg : arg?.days || 30;
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return { start, end: new Date() };
}

// Idempotent — same (shop, orderId) twice is a no-op. Called by the
// orders/create webhook AFTER the chat's order tag is applied successfully.
export async function recordChatConversion({ shop, orderId, orderName, totalAmount, currency, customerId }) {
  if (!shop || !orderId) return;
  try {
    await prisma.chatConversion.upsert({
      where: { shop_orderId: { shop, orderId: String(orderId) } },
      update: {},
      create: {
        shop,
        orderId: String(orderId),
        orderName: orderName ? String(orderName).slice(0, 80) : null,
        totalAmount: typeof totalAmount === "number" ? totalAmount : (totalAmount ? Number(totalAmount) : null),
        currency: currency ? String(currency).slice(0, 8) : null,
        customerId: customerId ? String(customerId).slice(0, 80) : null,
      },
    });
  } catch (err) {
    console.error("[ChatConversion] record error:", err?.message);
  }
}

// Returns count + sum(totalAmount) + AOV for the given range. The
// currency reported is whatever the most-recent order used —
// multi-currency stores will see mixed totals here. Acceptable for v1
// since 99% of merchants are single-currency; revisit if Aetrex
// expands internationally.
export async function getConversionSummary(shop, range = 30) {
  const { start, end } = resolveRange(range);
  const rows = await prisma.chatConversion.findMany({
    where: { shop, createdAt: { gte: start, lte: end } },
    select: { totalAmount: true, currency: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const count = rows.length;
  const revenue = rows.reduce((s, r) => s + (Number(r.totalAmount) || 0), 0);
  const currency = rows[0]?.currency || null;
  const aov = count > 0 ? revenue / count : 0;
  return { count, revenue, currency, aov };
}

// One row per calendar day across the range (zero-filled) so the home
// page metric strip can draw orders / revenue sparklines without
// re-deriving the date scaffold client-side.
export async function getConversionDailySeries(shop, range = 30, { timeZone = "" } = {}) {
  const dayKey = dayKeyIn(timeZone);
  const { start, end } = resolveRange(range);
  const rows = await prisma.chatConversion.findMany({
    where: { shop, createdAt: { gte: start, lte: end } },
    select: { totalAmount: true, createdAt: true },
  });
  const map = new Map();
  for (const key of dayKeysBetween(start, end, dayKey)) {
    map.set(key, { date: key, count: 0, revenue: 0 });
  }
  for (const r of rows) {
    const key = dayKey(r.createdAt);
    const row = map.get(key);
    if (!row) continue;
    row.count += 1;
    row.revenue += Number(r.totalAmount) || 0;
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}
