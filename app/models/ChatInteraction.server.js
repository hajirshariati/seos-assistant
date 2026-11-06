import { createHash } from "node:crypto";
import prisma from "../db.server";
import { dayKeyIn } from "../lib/store-day.js";

// Customer service log (NYC DCWP 6 RCNY 5-313): one row per chat with the
// assistant, kept three years — when, how many messages, whether a way to
// reach a person was offered and used. Never message text. The visitor is
// the widget's random browser id, hashed, so repeat visits within 72 hours
// can be counted without identifying anyone.

export const KEEP_DAYS = 3 * 365 + 5;
const DISCLOSURE_MAX = 1200;

const sid = (v) => String(v || "").slice(0, 80);
export const visitorHash = (v) => (v ? createHash("sha256").update(String(v).slice(0, 80)).digest("hex").slice(0, 24) : "");

// The exact opening words shown (greeting + the note under the box), kept
// once per distinct text with first/last seen; returns its id.
export async function recordDisclosure(shop, text) {
  const t = String(text || "").replace(/\s+/g, " ").trim().slice(0, DISCLOSURE_MAX);
  if (!shop || !t) return "";
  const row = await prisma.chatDisclosure.upsert({
    where: { shop_text: { shop, text: t } },
    create: { shop, text: t },
    update: { lastSeenAt: new Date() },
  });
  return row.id;
}

// A message in a chat: the row is created on the first, counted on each.
export async function touchInteraction(shop, { sessionId, visitor = "", signedIn = false, humanOffered = true, disclosure = "" }) {
  const id = sid(sessionId);
  if (!shop || !id) return null;
  const now = new Date();
  const existing = await prisma.chatInteraction.findUnique({ where: { shop_sessionId: { shop, sessionId: id } } });
  // The opening words come with the first message; a row made by an earlier
  // "Talk to a person" tap (no message yet) still gets them.
  const disclosureId = disclosure && !existing?.disclosureId ? await recordDisclosure(shop, disclosure).catch(() => "") : "";
  if (existing) {
    return prisma.chatInteraction.update({
      where: { shop_sessionId: { shop, sessionId: id } },
      data: { lastAt: now, messages: { increment: 1 }, signedIn: existing.signedIn || Boolean(signedIn), humanOffered: existing.humanOffered || Boolean(humanOffered), ...(disclosureId ? { disclosureId } : {}) },
    });
  }
  return prisma.chatInteraction.create({
    data: { shop, sessionId: id, visitor: visitorHash(visitor), startedAt: now, lastAt: now, messages: 1, signedIn: Boolean(signedIn), humanOffered: Boolean(humanOffered), disclosureId },
  });
}

// The shopper asked for a person: how (live_chat | phone | email | page).
export async function markHuman(shop, { sessionId, how = "" }) {
  const id = sid(sessionId);
  const outcome = ["live_chat", "phone", "email", "page"].includes(how) ? how : "page";
  if (!shop || !id) return null;
  const existing = await prisma.chatInteraction.findUnique({ where: { shop_sessionId: { shop, sessionId: id } } });
  if (!existing) {
    // A person asked for before any message was sent: still a covered interaction.
    return prisma.chatInteraction.create({ data: { shop, sessionId: id, messages: 0, humanOffered: true, humanActivated: true, outcome } });
  }
  return prisma.chatInteraction.update({ where: { shop_sessionId: { shop, sessionId: id } }, data: { lastAt: new Date(), humanOffered: true, humanActivated: true, outcome } });
}

// Chats that sent at least one message, by the store's day they started:
// { byDay: { "YYYY-MM-DD": n }, total } — the engagement rate's numerator.
export async function countChatsByDay(shop, { start, end }, { timeZone = "" } = {}) {
  const dayKey = dayKeyIn(timeZone);
  const rows = await prisma.chatInteraction.findMany({
    where: { shop, messages: { gte: 1 }, startedAt: { gte: start, lte: end } },
    select: { startedAt: true },
    take: 400000,
  });
  const byDay = {};
  for (const r of rows) { const k = dayKey(r.startedAt); byDay[k] = (byDay[k] || 0) + 1; }
  return { byDay, total: rows.length };
}

export async function listInteractions(shop, { since = null, until = null, take = 200000 } = {}) {
  const where = { shop };
  if (since || until) where.startedAt = { ...(since ? { gte: since } : {}), ...(until ? { lt: until } : {}) };
  return prisma.chatInteraction.findMany({ where, orderBy: { startedAt: "asc" }, take });
}

export async function listDisclosures(shop) {
  return prisma.chatDisclosure.findMany({ where: { shop }, orderBy: { firstSeenAt: "asc" } });
}

export async function cleanupOldInteractions() {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.chatInteraction.deleteMany({ where: { startedAt: { lt: cutoff } } });
  if (count > 0) console.log(`[service-log] removed ${count} chat(s) older than ${KEEP_DAYS} days`);
  return count;
}
