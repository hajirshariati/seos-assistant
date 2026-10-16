import prisma from "../db.server";

const RETENTION_DAYS = 90;

// topics: [{ kind, value }] from one chat turn (lean engine result.topics).
export async function logTopics(shop, topics) {
  if (!shop || !topics?.length) return;
  const data = topics
    .filter((t) => t?.kind)
    .map((t) => ({ shop, kind: String(t.kind).slice(0, 40), value: String(t.value || "").slice(0, 120) }));
  if (data.length === 0) return;
  try {
    await prisma.chatTopic.createMany({ data });
  } catch (err) {
    console.error("[ChatTopic] log error:", err?.message);
  }
}

export async function getTopicRows(shop, { days = 7 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return prisma.chatTopic.findMany({
    where: { shop, createdAt: { gte: since } },
    select: { kind: true, value: true },
    take: 50000,
  });
}

export async function cleanupOldTopics() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    await prisma.chatTopic.deleteMany({ where: { createdAt: { lt: cutoff } } });
  } catch (err) {
    console.error("[ChatTopic] cleanup error:", err?.message);
  }
}
