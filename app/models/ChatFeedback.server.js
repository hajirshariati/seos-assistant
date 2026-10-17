import crypto from "crypto";
import prisma from "../db.server";

// Keyed with the app's secret, so a stored hash can't be turned back into
// an IP address by hashing every possible one.
function hashValue(value) {
  if (!value) return null;
  return crypto.createHmac("sha256", process.env.ENCRYPTION_KEY || "seos").update(value).digest("hex").slice(0, 16);
}

// Shoppers sometimes type contact details; the stored transcript doesn't keep them.
export function redactContactDetails(text) {
  return String(text || "")
    .replace(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\+?\(?\d[\d\s().-]{7,}\d/g, "[number]");
}

export async function recordFeedback({ shop, sessionId, vote, botResponse, products, conversation, ip }) {
  const transcript = Array.isArray(conversation)
    ? conversation
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .slice(-10)
      .map((m) => ({ role: m.role, content: redactContactDetails(String(m.content || "").slice(0, 300)) }))
    : null;
  return prisma.chatFeedback.create({
    data: {
      shop,
      sessionId,
      vote,
      botResponse: redactContactDetails((botResponse || "").slice(0, 500)),
      products: (products || []).slice(0, 5).map((p) => String(typeof p === "string" ? p : p?.title || "").slice(0, 200)),
      conversation: transcript ? JSON.stringify(transcript) : null,
      userHash: hashValue(ip),
    },
  });
}

function resolveRange(arg) {
  if (arg && typeof arg === "object" && arg.startDate && arg.endDate) {
    return { start: new Date(arg.startDate), end: new Date(arg.endDate) };
  }
  const days = typeof arg === "number" ? arg : arg?.days || 30;
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return { start, end: new Date() };
}

export async function getFeedbackSummary(shop, range = 30) {
  const { start, end } = resolveRange(range);
  const all = await prisma.chatFeedback.findMany({
    where: { shop, createdAt: { gte: start, lte: end } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      vote: true,
      botResponse: true,
      products: true,
      conversation: true,
      userHash: true,
      createdAt: true,
    },
  });

  const up = all.filter((f) => f.vote === "up").length;
  const down = all.filter((f) => f.vote === "down").length;
  const total = up + down;

  // Pre-parse conversation JSON into a clean transcript array so the
  // analytics page can render the full back-and-forth without re-
  // parsing client-side. Each entry is {role, content} (assistant or
  // user), capped at 20 turns and 1000 chars per turn for sanity —
  // the raw column may already be 500-char-bot-response truncated,
  // but the conversation JSON wasn't bounded.
  const decorated = all
    .filter((f) => f.vote === "down")
    .map((f) => {
      let transcript = [];
      if (f.conversation) {
        try {
          const conv = JSON.parse(f.conversation);
          if (Array.isArray(conv)) {
            transcript = conv
              .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
              .slice(-20)
              .map((m) => ({
                role: m.role,
                content: String(m.content).slice(0, 1000),
              }));
          }
        } catch {}
      }
      // Find the customer's last question before the flagged
      // response. Helps show "what was the customer asking when this
      // bad response came back?" without expanding the full thread.
      const lastUser = [...transcript].reverse().find((m) => m.role === "user");
      return {
        id: f.id,
        createdAt: f.createdAt,
        vote: f.vote,
        botResponse: f.botResponse,
        products: f.products || [],
        transcript,
        lastUserQuestion: lastUser?.content || null,
      };
    });

  return {
    total,
    up,
    down,
    satisfactionRate: total > 0 ? Math.round((up / total) * 100) : 0,
    negativeFeedback: decorated.slice(0, 20),
  };
}

export async function getRecentQuestions(shop, range = 30, limit = 15) {
  const { start, end } = resolveRange(range);
  const records = await prisma.chatFeedback.findMany({
    where: { shop, createdAt: { gte: start, lte: end }, conversation: { not: null } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      conversation: true,
      vote: true,
      products: true,
      botResponse: true,
      createdAt: true,
    },
    take: limit * 2,
  });
  const questions = [];
  for (const r of records) {
    try {
      const conv = JSON.parse(r.conversation);
      if (!Array.isArray(conv)) continue;
      const firstUser = conv.find((m) => m.role === "user");
      if (!firstUser?.content) continue;
      const transcript = conv
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-20)
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 1000) }));
      // The customer's last question before the vote landed — useful
      // as a 'CUSTOMER ASKED' headline when the conversation is long
      // and the first message is no longer the relevant one.
      const lastUser = [...transcript].reverse().find((m) => m.role === "user");
      questions.push({
        id: r.id,
        question: String(firstUser.content).slice(0, 200),
        lastUserQuestion: lastUser?.content || null,
        // For down-voted rows, surface the AI's response that was
        // flagged. Rendered inline as 'AI RESPONDED' on the row so
        // the merchant can see the failure mode without expanding.
        flaggedAiResponse: r.vote === "down" ? (r.botResponse || null) : null,
        vote: r.vote,
        products: r.products || [],
        date: r.createdAt,
        transcript,
      });
    } catch {}
    if (questions.length >= limit) break;
  }
  return questions;
}

export async function cleanupOldFeedback() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const { count } = await prisma.chatFeedback.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  if (count > 0) console.log(`[feedback] cleaned up ${count} records older than 90 days`);
  return count;
}
