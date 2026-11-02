import prisma from "../db.server";

// Chat guard state (chat-guard.js), per chat ("session:<id>") and per
// address ("ip:<address>"). Kept in the database so every server instance
// sees the same count; rows go a day after their last change.

const KEEP_MS = 24 * 60 * 60 * 1000;

export const sessionKey = (sessionId) => `session:${String(sessionId || "").slice(0, 80) || "unknown"}`;
export const ipKey = (ip) => `ip:${String(ip || "unknown").slice(0, 64)}`;

export async function getGuardStates(shop, keys) {
  const rows = await prisma.chatGuard.findMany({ where: { shop, key: { in: keys } } });
  const out = {};
  for (const k of keys) out[k] = rows.find((r) => r.key === k) || null;
  return out;
}

export async function saveGuardState(shop, key, state) {
  const data = {
    strikes: Number(state?.strikes) || 0,
    lastCategory: String(state?.lastCategory || ""),
    lastStrikeAt: state?.lastStrikeAt ? new Date(state.lastStrikeAt) : null,
    lockedUntil: state?.lockedUntil ? new Date(state.lockedUntil) : null,
  };
  return prisma.chatGuard.upsert({ where: { shop_key: { shop, key } }, create: { shop, key, ...data }, update: data });
}

// Admin "Unlock now": the chat (and nothing else) can send again.
export async function unlockGuardSession(shop, sessionId) {
  const key = sessionKey(sessionId);
  const { count } = await prisma.chatGuard.updateMany({ where: { shop, key }, data: { lockedUntil: null, strikes: 0, lastCategory: "", lastStrikeAt: null } });
  return count;
}

export async function cleanupOldGuards() {
  const cutoff = new Date(Date.now() - KEEP_MS);
  const { count } = await prisma.chatGuard.deleteMany({ where: { updatedAt: { lt: cutoff }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] } });
  if (count > 0) console.log(`[guard] dropped ${count} old guard row(s)`);
  return count;
}
