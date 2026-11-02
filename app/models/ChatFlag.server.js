import prisma from "../db.server";

// Flagged recorded chats (Recordings): by the store team ("manual"), or by
// the chat guard — "guard" when it ended the chat, "watch" when it would
// have in watch mode. A flagged chat is never deleted by Delete all, Delete
// day or the daily clean-up; only that chat's own Delete removes it.

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
export async function setFlag(shop, sessionId, { kind = "manual", note = "" } = {}) {
  const id = sid(sessionId);
  if (!shop || !id) return null;
  const data = { kind, note: String(note || "").slice(0, 400) };
  const existing = await prisma.chatFlag.findUnique({ where: { shop_sessionId: { shop, sessionId: id } } });
  if (existing?.kind === "manual" && kind !== "manual") {
    return prisma.chatFlag.update({ where: { shop_sessionId: { shop, sessionId: id } }, data: { note: data.note || existing.note } });
  }
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
