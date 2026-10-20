import prisma from "../db.server";
import { KEEP_DAYS, cleanTester } from "../lib/chat-recording.js";
import { redactContactDetails } from "./ChatFeedback.server";

// Saves one recorded turn (only called while recording applies — see
// app/lib/chat-recording.js). Contact details are removed; lengths capped.
export async function saveRecording({ shop, sessionId, tester, page, message, reply, products = [], extras = "", ok = true }) {
  return prisma.chatRecording.create({
    data: {
      shop,
      sessionId: String(sessionId || "").slice(0, 80) || "unknown",
      tester: cleanTester(tester),
      page: String(page || "").replace(/[?#].*$/, "").slice(0, 200),
      message: redactContactDetails(String(message || "").slice(0, 2000)),
      reply: redactContactDetails(String(reply || "").slice(0, 6000)),
      products: (products || []).slice(0, 12).map((p) => String(p || "").slice(0, 200)),
      extras: String(extras || "").slice(0, 600),
      ok: Boolean(ok),
    },
  });
}

export async function listRecordings(shop, { days = KEEP_DAYS } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return prisma.chatRecording.findMany({
    where: { shop, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
}

export async function deleteAllRecordings(shop) {
  const { count } = await prisma.chatRecording.deleteMany({ where: { shop } });
  return count;
}

export async function cleanupOldRecordings() {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.chatRecording.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count > 0) console.log(`[recordings] cleaned up ${count} recorded turns older than ${KEEP_DAYS} days`);
  return count;
}
