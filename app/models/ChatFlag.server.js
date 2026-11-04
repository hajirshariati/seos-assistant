import prisma from "../db.server";
import { FLAG_NOTE_MAX, cleanNote } from "../lib/chat-flags.js";

// Flagged recorded chats (Recordings): by the store team ("manual", with
// their comment on what should have gone better and who left it), or by
// the chat guard — "guard" when it ended the chat, "watch" when it would
// have in watch mode. A flagged chat is never cleaned up while the flag
// stays.

export { FLAG_NOTE_MAX, cleanNote };

const sid = (sessionId) => String(sessionId || "").slice(0, 80);

export async function listFlags(shop) {
  return prisma.chatFlag.findMany({ where: { shop }, orderBy: { createdAt: "desc" } });
}

export async function flaggedSessionIds(shop) {
  const rows = await prisma.chatFlag.findMany({ where: { shop }, select: { sessionId: true } });
  return rows.map((r) => r.sessionId);
}

// Sets (or updates) a chat's flag. A chat the team flagged by hand keeps
// that flag when the guard also strikes it; the guard's note is kept too.
export async function setFlag(shop, sessionId, { kind = "manual", note = "", by = "" } = {}) {
  const id = sid(sessionId);
  if (!shop || !id) return null;
  const data = { kind, note: cleanNote(note), flaggedBy: String(by || "").trim().slice(0, 120) };
  const existing = await prisma.chatFlag.findUnique({ where: { shop_sessionId: { shop, sessionId: id } } });
  if (existing?.kind === "manual" && kind !== "manual") {
    return prisma.chatFlag.update({ where: { shop_sessionId: { shop, sessionId: id } }, data: { note: existing.note || data.note } });
  }
  // Flagging by hand a chat already flagged keeps its comment.
  if (existing && kind === "manual" && !data.note) return existing;
  return prisma.chatFlag.upsert({
    where: { shop_sessionId: { shop, sessionId: id } },
    create: { shop, sessionId: id, ...data },
    update: data,
  });
}

// The team's comment on a chat: flags it (by hand) when it isn't yet, and
// replaces the note — a guard-flagged chat becomes the team's.
export async function noteFlag(shop, sessionId, { note = "", by = "" } = {}) {
  const id = sid(sessionId);
  if (!shop || !id) return null;
  const data = { kind: "manual", note: cleanNote(note), flaggedBy: String(by || "").trim().slice(0, 120) };
  return prisma.chatFlag.upsert({
    where: { shop_sessionId: { shop, sessionId: id } },
    create: { shop, sessionId: id, ...data },
    update: data,
  });
}

export async function clearFlag(shop, sessionId) {
  const id = sid(sessionId);
  if (!shop || !id) return 0;
  const { count } = await prisma.chatFlag.deleteMany({ where: { shop, sessionId: id } });
  return count;
}
