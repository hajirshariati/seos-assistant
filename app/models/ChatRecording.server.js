import prisma from "../db.server";
import { keepDays, cleanTester } from "../lib/chat-recording.js";
import { redactContactDetails } from "./ChatFeedback.server";

// Saves one recorded turn (only called while recording applies — see
// app/lib/chat-recording.js — or when the chat guard struck the message).
// Contact details are removed; lengths capped.
export async function saveRecording({ shop, sessionId, tester, page, typed = null, message, reply, products = [], extras = "", ok = true, guard = "" }) {
  return prisma.chatRecording.create({
    data: {
      shop,
      sessionId: String(sessionId || "").slice(0, 80) || "unknown",
      tester: cleanTester(tester),
      page: String(page || "").replace(/[?#].*$/, "").slice(0, 200),
      typed: typeof typed === "boolean" ? typed : null,
      message: redactContactDetails(String(message || "").slice(0, 2000)),
      reply: redactContactDetails(String(reply || "").slice(0, 6000)),
      products: (products || []).slice(0, 12).map((p) => String(p || "").slice(0, 200)),
      extras: String(extras || "").slice(0, 600),
      ok: Boolean(ok),
      guard: String(guard || "").slice(0, 40),
    },
  });
}

// The recorded turns of the last `days` days (or of the named chats, whatever
// their age), newest first. Chats the store deleted before "Top shopper
// issues & questions" read them (trashed) never show.
export async function listRecordings(shop, { days = 7, sessionIds = null, take = 20000 } = {}) {
  const where = { shop, trashed: false };
  if (Array.isArray(sessionIds)) {
    if (!sessionIds.length) return [];
    where.sessionId = { in: sessionIds.slice(0, 2000) };
  } else {
    where.createdAt = { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
  }
  return prisma.chatRecording.findMany({ where, orderBy: { createdAt: "desc" }, take });
}

// The days (store time zone keys are the page's; here, the newest turn per
// chat) that have chats, for the page's older-days list.
export async function recordingDays(shop, { days = 400 } = {}) {
  const rows = await prisma.chatRecording.findMany({
    where: { shop, trashed: false, createdAt: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } },
    select: { createdAt: true, sessionId: true },
    orderBy: { createdAt: "desc" },
    take: 200000,
  });
  return rows;
}

// Deleting chats never changes "Top shopper issues & questions": a chat that
// read has already counted goes now; one it hasn't read yet is trashed
// (hidden everywhere) and goes once the read has counted it. Flagged chats
// are skipped unless `includeFlagged` (the chat's own Delete).
async function removeOrTrash(shop, where, { includeFlagged = false } = {}) {
  const flagged = includeFlagged ? [] : (await prisma.chatFlag.findMany({ where: { shop }, select: { sessionId: true } })).map((f) => f.sessionId);
  const scope = { ...where, shop, trashed: false, ...(flagged.length ? { sessionId: { ...(where.sessionId || {}), notIn: flagged } } : {}) };
  const read = (await prisma.chatConcernChat.findMany({ where: { shop }, select: { sessionId: true } })).map((l) => l.sessionId);
  // Chats "Top shopper issues" has read, and chats it never reads (testers',
  // and the admin's Test chat), go now; the rest wait for the read.
  const gone = await prisma.chatRecording.deleteMany({ where: { ...scope, OR: [{ sessionId: { in: read } }, { tester: { not: "" } }] } });
  const held = await prisma.chatRecording.updateMany({ where: scope, data: { trashed: true } });
  return { deleted: gone.count, trashed: held.count };
}

export async function deleteAllRecordings(shop) {
  return removeOrTrash(shop, {});
}

// Every chat whose first turn falls in [start, end) — a store-local day.
// Flagged chats stay, and aren't counted in `chats`.
export async function deleteDayRecordings(shop, { start, end }) {
  const firsts = await prisma.chatRecording.groupBy({ by: ["sessionId"], where: { shop, trashed: false }, _min: { createdAt: true } });
  const flagged = new Set((await prisma.chatFlag.findMany({ where: { shop }, select: { sessionId: true } })).map((f) => f.sessionId));
  const ids = firsts.filter((f) => f._min.createdAt >= start && f._min.createdAt < end && !flagged.has(f.sessionId)).map((f) => f.sessionId);
  if (!ids.length) return { deleted: 0, trashed: 0, chats: 0 };
  const out = await removeOrTrash(shop, { sessionId: { in: ids } });
  return { ...out, chats: ids.length };
}

// One recorded chat (all its turns), only within this shop — flagged or not;
// its flag goes with it.
export async function deleteRecordingSession(shop, sessionId) {
  const id = String(sessionId || "").slice(0, 80);
  if (!shop || !id) return { deleted: 0, trashed: 0 };
  const out = await removeOrTrash(shop, { sessionId: { in: [id] } }, { includeFlagged: true });
  await prisma.chatFlag.deleteMany({ where: { shop, sessionId: id } });
  return out;
}

// After a read of "Top shopper issues & questions": trashed chats it has now
// counted are removed for good.
export async function purgeReadTrash(shop) {
  const read = (await prisma.chatConcernChat.findMany({ where: { shop }, select: { sessionId: true } })).map((l) => l.sessionId);
  const { count } = await prisma.chatRecording.deleteMany({ where: { shop, trashed: true, OR: [{ sessionId: { in: read } }, { tester: { not: "" } }] } });
  if (count > 0) console.log(`[recordings] removed ${count} deleted turn(s) now read shop=${shop}`);
  return count;
}

// The daily clean-up: each store's chats older than its keep-days setting,
// flagged chats excepted. Runs after the day's concern read, so chats still
// to be read are trashed, not lost.
export async function cleanupOldRecordings() {
  const shops = await prisma.chatRecording.findMany({ distinct: ["shop"], select: { shop: true } });
  let total = 0;
  for (const { shop } of shops) {
    try {
      const config = await prisma.shopConfig.findUnique({ where: { shop }, select: { recordKeepDays: true } });
      const cutoff = new Date(Date.now() - keepDays(config) * 24 * 60 * 60 * 1000);
      const old = await prisma.chatRecording.groupBy({ by: ["sessionId"], where: { shop, trashed: false }, _max: { createdAt: true } });
      const ids = old.filter((s) => s._max.createdAt < cutoff).map((s) => s.sessionId);
      if (!ids.length) continue;
      const out = await removeOrTrash(shop, { sessionId: { in: ids } });
      total += out.deleted;
      if (out.deleted || out.trashed) console.log(`[recordings] shop=${shop} cleaned up ${out.deleted} turn(s) past ${keepDays(config)} days (${out.trashed} waiting to be read)`);
    } catch (err) {
      console.error(`[recordings] clean-up failed shop=${shop}:`, err?.message || err);
    }
  }
  return total;
}
