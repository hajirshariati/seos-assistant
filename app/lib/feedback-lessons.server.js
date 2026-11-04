// Lessons from thumbs-down — the daily job and the page's actions (rules in
// feedback-lessons.js). Drafts are made once a day by the retention run,
// or on demand from the Analytics page; approving one writes it into the
// store's knowledge (a fact) or its rules (a behaviour); nothing reaches the
// assistant on its own.
import Anthropic from "@anthropic-ai/sdk";
import prisma from "../db.server";
import { DEFAULT_MODEL } from "./claude-models.js";
import { withAnthropicRetry } from "./anthropic-resilience.server.js";
import { getShopConfig } from "../models/ShopConfig.server";
import { getRecentQuestions, redactContactDetails } from "../models/ChatFeedback.server";
import { resolveShopEmbedding } from "./embeddings.server";
import { rebuildChunksForFile } from "./knowledge-chunks.server";
import { FEEDBACK_SUBJECTS } from "./chat-rating.js";
import {
  LESSON_DAYS, LESSON_REST_DAYS, SYSTEM_PROMPT, LESSON_TOOL, LESSONS_FILE, RULES_FILE_NAME,
  groupDowns, lessonPrompt, parseLesson, lessonExamples, lessonNote,
} from "./feedback-lessons.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function toolInput(resp) {
  const block = (Array.isArray(resp?.content) ? resp.content : []).find((b) => b?.type === "tool_use" && b.name === LESSON_TOOL.name);
  if (!block) throw new Error("the model gave no lesson");
  return block.input || {};
}

// Drafts for one store: the thumbs-down of the last LESSON_DAYS by subject;
// a subject with a draft waiting, or decided in the last LESSON_REST_DAYS,
// is left alone. Returns what was drafted.
export async function draftLessons(shop, { apiKey, client, model = DEFAULT_MODEL, now = new Date() } = {}) {
  const since = new Date(now.getTime() - LESSON_DAYS * DAY_MS);
  const rows = (await getRecentQuestions(shop, { startDate: since, endDate: now }, 500)).filter((r) => r.vote === "down");
  const groups = groupDowns(rows);
  if (groups.length === 0) return { drafted: [], skipped: [] };
  const rest = new Date(now.getTime() - LESSON_REST_DAYS * DAY_MS);
  const existing = await prisma.feedbackLesson.findMany({
    where: { shop, OR: [{ status: "draft" }, { decidedAt: { gte: rest } }] },
    select: { subject: true },
  });
  const busy = new Set(existing.map((l) => l.subject));
  const ai = client || new Anthropic({ apiKey, timeout: 90_000, maxRetries: 0 });
  const drafted = [];
  const skipped = [];
  for (const g of groups) {
    if (busy.has(g.subject)) { skipped.push(g.subject); continue; }
    const prompt = redactContactDetails(lessonPrompt(g));
    const resp = await withAnthropicRetry(
      () => ai.messages.create({
        model,
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        tools: [LESSON_TOOL],
        tool_choice: { type: "tool", name: LESSON_TOOL.name },
        messages: [{ role: "user", content: prompt }],
      }),
      { label: "feedback-lessons" },
    );
    const parsed = parseLesson(toolInput(resp));
    if (!parsed) { skipped.push(g.subject); continue; }
    const row = await prisma.feedbackLesson.create({
      data: {
        shop,
        subject: g.subject,
        count: g.rows.length,
        lesson: parsed.lesson,
        kind: parsed.kind,
        fix: parsed.fix,
        examples: lessonExamples(g.rows).map((e) => redactContactDetails(e)),
        feedbackIds: g.rows.map((r) => r.id),
        status: "draft",
      },
    });
    drafted.push(row);
  }
  return { drafted, skipped };
}

// The daily run: every store with an AI key.
export async function draftAllLessons() {
  const shops = await prisma.shopConfig.findMany({ where: { anthropicApiKey: { not: null } }, select: { shop: true, anthropicApiKey: true } });
  let drafted = 0;
  for (const s of shops) {
    if (!s.anthropicApiKey) continue;
    try {
      const r = await draftLessons(s.shop, { apiKey: s.anthropicApiKey });
      drafted += r.drafted.length;
    } catch (err) {
      console.error(`[lessons] ${s.shop}: ${err?.message || err}`);
    }
  }
  if (drafted > 0) console.log(`[lessons] drafted ${drafted} lesson(s) across ${shops.length} shop(s)`);
  return drafted;
}

// On demand from the page, with the store's own key.
export async function draftLessonsNow(shop) {
  const config = await getShopConfig(shop);
  if (!config?.anthropicApiKey) return { error: "Add the AI key in Settings first." };
  const r = await draftLessons(shop, { apiKey: config.anthropicApiKey });
  return { drafted: r.drafted.length, skipped: r.skipped.length };
}

const shape = (l) => ({
  id: l.id, subject: l.subject, label: FEEDBACK_SUBJECTS[l.subject] || l.subject, count: l.count, lesson: l.lesson, kind: l.kind, fix: l.fix,
  examples: l.examples || [], status: l.status, source: l.source || "feedback", createdAt: l.createdAt, decidedAt: l.decidedAt,
});

// The page: drafts waiting, newest first, and the last few decided.
export async function listLessons(shop) {
  const [drafts, decided] = await Promise.all([
    prisma.feedbackLesson.findMany({ where: { shop, status: "draft" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20 }),
    prisma.feedbackLesson.findMany({ where: { shop, status: { in: ["approved", "dismissed"] } }, orderBy: [{ decidedAt: "desc" }, { id: "desc" }], take: 8 }),
  ]);
  return { drafts: drafts.map(shape), decided: decided.map(shape) };
}

// Approve: a knowledge lesson joins the store's "Lessons" knowledge file
// (one file, dated notes, chunked for retrieval when the store embeds); a
// behaviour lesson joins its rules. Dismiss: kept, rests, nothing written.
export async function decideLesson(shop, id, decision) {
  const lesson = await prisma.feedbackLesson.findFirst({ where: { id, shop } });
  if (!lesson) return { error: "That lesson is gone." };
  if (lesson.status !== "draft") return { error: "Already decided." };
  if (decision !== "approved" && decision !== "dismissed") return { error: "Unknown decision." };
  if (decision === "approved") {
    const note = lessonNote(lesson);
    if (lesson.kind === "knowledge" && lesson.fix) await appendToFile(shop, LESSONS_FILE.fileType, LESSONS_FILE.fileName, note, { chunk: true });
    else await appendToFile(shop, "rules", RULES_FILE_NAME, note, { chunk: false });
  }
  await prisma.feedbackLesson.update({ where: { id }, data: { status: decision, decidedAt: new Date() } });
  return { ok: true, decision };
}

async function appendToFile(shop, fileType, fileName, note, { chunk }) {
  const existing = await prisma.knowledgeFile.findFirst({ where: { shop, fileType } });
  const content = existing?.content ? `${existing.content.replace(/\s+$/, "")}\n\n${note}` : note;
  const data = { fileName: existing?.fileName || fileName, fileSize: Buffer.byteLength(content, "utf8"), content, updatedAt: new Date() };
  const saved = existing
    ? await prisma.knowledgeFile.update({ where: { id: existing.id }, data })
    : await prisma.knowledgeFile.create({ data: { shop, fileType, ...data } });
  if (!chunk) return saved;
  try {
    const config = await getShopConfig(shop);
    const resolved = resolveShopEmbedding(config);
    if (resolved) await rebuildChunksForFile(prisma, { shop, sourceFileId: saved.id, fileType, content, provider: resolved.provider, apiKey: resolved.apiKey });
  } catch (err) {
    console.error(`[lessons] chunks for ${shop} not rebuilt: ${err?.message || err}`);
  }
  return saved;
}
