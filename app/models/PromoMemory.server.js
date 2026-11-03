import prisma from "../db.server";
import { diffPromoLines, promoLines, DAY_MS } from "../lib/memory.js";

// Memory of offers (see app/lib/memory.js). One row per offer line the
// promotions page showed, or per dated campaign; ended rows stay for the
// store's window and are removed after a year regardless.

export const MAX_KEEP_DAYS = 400;
const CAMPAIGN_TEXT_MAX = 300;

// A successful read of the promotions page: open lines that are gone end
// now, new lines start, edited lines carry on under their new words.
export async function recordPromoSnapshot(shop, text, now = new Date()) {
  if (!shop) return null;
  const lines = promoLines(text);
  const open = await prisma.promoMemory.findMany({ where: { shop, source: "page", endedAt: null }, select: { id: true, text: true } });
  const diff = diffPromoLines(open.map((r) => r.text), lines);
  const byText = new Map(open.map((r) => [r.text, r.id]));
  const ops = [];
  if (diff.kept.length) ops.push(prisma.promoMemory.updateMany({ where: { id: { in: diff.kept.map((t) => byText.get(t)) } }, data: { lastSeenAt: now } }));
  if (diff.ended.length) ops.push(prisma.promoMemory.updateMany({ where: { id: { in: diff.ended.map((t) => byText.get(t)) } }, data: { endedAt: now } }));
  for (const e of diff.edited) {
    // The new words may already be a row (an old, ended offer brought back as is).
    const clash = await prisma.promoMemory.findUnique({ where: { shop_source_text: { shop, source: "page", text: e.to } } });
    if (clash) {
      ops.push(prisma.promoMemory.update({ where: { id: clash.id }, data: { endedAt: null, lastSeenAt: now } }));
      ops.push(prisma.promoMemory.update({ where: { id: byText.get(e.from) }, data: { endedAt: now } }));
    } else {
      ops.push(prisma.promoMemory.update({ where: { id: byText.get(e.from) }, data: { text: e.to, lastSeenAt: now } }));
    }
  }
  for (const t of diff.started) {
    ops.push(prisma.promoMemory.upsert({
      where: { shop_source_text: { shop, source: "page", text: t } },
      // Shown again after a break: a fresh run of the same offer.
      update: { endedAt: null, firstSeenAt: now, lastSeenAt: now },
      create: { shop, source: "page", text: t, firstSeenAt: now, lastSeenAt: now },
    }));
  }
  if (ops.length) await prisma.$transaction(ops);
  if (diff.ended.length || diff.started.length) console.log(`[memory] ${shop}: offers — ${diff.started.length} started, ${diff.ended.length} ended, ${diff.edited.length} edited`);
  return diff;
}

// A dated campaign (Knowledge → Campaigns): remembered by its name and first
// line, with its own dates — deleting the campaign later keeps the memory.
export async function rememberCampaign(shop, { name, content, startsAt, endsAt }) {
  if (!shop || !name) return null;
  const first = String(content || "").split(/\n/).map((l) => l.trim()).find((l) => l && !/^[#*=\-–—\s]+$/.test(l)) || "";
  const text = `${String(name).trim()}${first && first.toLowerCase() !== String(name).trim().toLowerCase() ? ` — ${first.replace(/^[#*\-–—\s]+/, "")}` : ""}`.slice(0, CAMPAIGN_TEXT_MAX);
  return prisma.promoMemory.upsert({
    where: { shop_source_text: { shop, source: "campaign", text } },
    update: { firstSeenAt: new Date(startsAt), lastSeenAt: new Date(endsAt), endedAt: new Date(endsAt) },
    create: { shop, source: "campaign", text, firstSeenAt: new Date(startsAt), lastSeenAt: new Date(endsAt), endedAt: new Date(endsAt) },
  });
}

// Everything remembered for the chat's lookup: open page lines, campaigns
// (a campaign still running has endedAt ahead of now), and ended rows
// within the window.
export async function listPromoMemory(shop, { days = 90, now = Date.now() } = {}) {
  if (!shop) return [];
  const since = new Date(now - days * DAY_MS);
  const rows = await prisma.promoMemory.findMany({
    where: { shop, OR: [{ endedAt: null }, { endedAt: { gte: since } }] },
    orderBy: { lastSeenAt: "desc" },
    take: 500,
  });
  // A campaign whose end is still ahead is running: the lookup treats a
  // row without endedAt as running.
  return rows.map((r) => (r.source === "campaign" && r.endedAt && r.endedAt.getTime() > now ? { ...r, endedAt: null } : r));
}

export async function cleanupOldPromoMemory() {
  const cutoff = new Date(Date.now() - MAX_KEEP_DAYS * DAY_MS);
  const { count } = await prisma.promoMemory.deleteMany({ where: { endedAt: { lt: cutoff } } });
  if (count > 0) console.log(`[memory] removed ${count} ended offer(s) older than ${MAX_KEEP_DAYS} days`);
  return count;
}
