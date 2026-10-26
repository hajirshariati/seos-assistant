// Storefront request outcomes for Health & Readiness: did the chat turn (or
// styled image) work, how long did it take, why did it fail. No message
// text and no customer data. Recording never slows or breaks a request.
import prisma from "../db.server";

const KEEP_DAYS = 30;

export function recordHealth({ shop, route = "chat", ok, latencyMs = 0, errorKind = null, internal = false }) {
  if (!shop) return;
  prisma.chatHealthEvent
    .create({
      data: {
        shop,
        route,
        ok: Boolean(ok),
        latencyMs: Math.max(0, Math.round(Number(latencyMs) || 0)),
        errorKind: errorKind ? String(errorKind).slice(0, 40) : null,
        internal: Boolean(internal),
      },
    })
    .catch((err) => console.error("[health] record failed:", err?.message || err));
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// Real shopper traffic only (admin test chats excluded).
export async function getHealthSummary(shop, { hours = 24 } = {}) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await prisma.chatHealthEvent.findMany({
    where: { shop, internal: false, createdAt: { gte: since } },
    select: { route: true, ok: true, latencyMs: true, errorKind: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 20000,
  });
  const summarize = (list) => {
    const okLatencies = list.filter((r) => r.ok).map((r) => r.latencyMs).sort((a, b) => a - b);
    const failed = list.filter((r) => !r.ok && r.errorKind !== "client_left");
    const byKind = {};
    for (const r of failed) byKind[r.errorKind || "unknown"] = (byKind[r.errorKind || "unknown"] || 0) + 1;
    const counted = list.filter((r) => r.errorKind !== "client_left").length;
    return {
      total: list.length,
      ok: list.length - failed.length - list.filter((r) => r.errorKind === "client_left").length,
      failed: failed.length,
      errorRate: counted ? failed.length / counted : null,
      p50Ms: percentile(okLatencies, 50),
      p95Ms: percentile(okLatencies, 95),
      errorsByKind: byKind,
      lastErrorAt: failed[0]?.createdAt?.toISOString?.() || null,
    };
  };
  return {
    hours,
    chat: summarize(rows.filter((r) => r.route === "chat")),
    visualize: summarize(rows.filter((r) => r.route === "visualize")),
  };
}

export async function cleanupOldHealth() {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
  try {
    await prisma.chatHealthEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  } catch (err) {
    console.error("[health] cleanup error:", err?.message);
  }
}

// Settings → Peak Mode's "right now" numbers: how busy the chat is, its
// busiest minute and hour this week (to size the limits against), what a
// message costs on average, and how many shoppers were turned away and why.
const TURNED_AWAY = ["store_rate_limited", "daily_cap", "rate_limit", "busy"];

export async function getChatPulse(shop, now = new Date()) {
  const t = now.getTime();
  const minuteAgo = new Date(t - 60_000);
  const hourAgo = new Date(t - 60 * 60_000);
  const weekAgo = new Date(t - 7 * 24 * 60 * 60_000);
  const real = { shop, internal: false };
  const [lastMinute, lastHour, busiest, avg, away] = await Promise.all([
    prisma.chatUsage.count({ where: { ...real, createdAt: { gte: minuteAgo } } }),
    prisma.chatUsage.count({ where: { ...real, createdAt: { gte: hourAgo } } }),
    prisma.$queryRaw`
      SELECT
        (SELECT COALESCE(MAX(n), 0)::int FROM (SELECT COUNT(*) AS n FROM "ChatUsage" WHERE shop = ${shop} AND NOT internal AND "createdAt" >= ${weekAgo} GROUP BY date_trunc('minute', "createdAt")) m) AS "busiestMinute",
        (SELECT COALESCE(MAX(n), 0)::int FROM (SELECT COUNT(*) AS n FROM "ChatUsage" WHERE shop = ${shop} AND NOT internal AND "createdAt" >= ${weekAgo} GROUP BY date_trunc('hour', "createdAt")) h) AS "busiestHour"`,
    prisma.chatUsage.aggregate({
      where: { ...real, createdAt: { gte: weekAgo }, NOT: { model: { startsWith: "image:" } } },
      _avg: { costUsd: true },
    }),
    prisma.chatHealthEvent.groupBy({
      by: ["errorKind"],
      where: { shop, internal: false, ok: false, errorKind: { in: TURNED_AWAY }, createdAt: { gte: weekAgo } },
      _count: { _all: true },
    }),
  ]);
  const count = (kind) => away.find((r) => r.errorKind === kind)?._count?._all || 0;
  return {
    lastMinute,
    lastHour,
    busiestMinute: Number(busiest?.[0]?.busiestMinute) || 0,
    busiestHour: Number(busiest?.[0]?.busiestHour) || 0,
    avgCostUsd: Number(avg?._avg?.costUsd) || 0,
    turnedAway: {
      storeLimit: count("store_rate_limited"),
      dailyCap: count("daily_cap"),
      aiBusy: count("rate_limit") + count("busy"),
    },
  };
}
