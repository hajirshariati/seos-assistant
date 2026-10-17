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
