// Chat review — the daily read of every recorded chat and the page's
// actions (rules in chat-review.js). Each run reads the chats not read yet
// (oldest first, a few per model call), keeps what it flagged, and drafts a
// lesson for a subject flagged more than once this week — the same card as
// the thumbs-down lessons; nothing reaches the assistant until approved.
import Anthropic from "@anthropic-ai/sdk";
import prisma from "../db.server";
import { DEFAULT_MODEL } from "./claude-models.js";
import { withAnthropicRetry } from "./anthropic-resilience.server.js";
import { getShopConfig } from "../models/ShopConfig.server";
import { redactContactDetails } from "../models/ChatFeedback.server";
import { FEEDBACK_SUBJECTS } from "./chat-rating.js";
import { SYSTEM_PROMPT as LESSON_SYSTEM_PROMPT, LESSON_TOOL, LESSON_REST_DAYS, parseLesson } from "./feedback-lessons.js";
import {
  SYSTEM_PROMPT, REVIEW_TOOL, REVIEW_LESSON_DAYS, PROBLEMS,
  chatsToReview, reviewBatches, reviewPrompt, parseFindings, groupFindings, findingsLessonPrompt,
} from "./chat-review.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Recorded turns older than this are never read (a store that turns the
// review on late starts from here, not from the start of its recordings).
const READ_BACK_DAYS = 7;
const KEEP_FINDINGS_DAYS = 90;

function toolInput(resp, name) {
  const block = (Array.isArray(resp?.content) ? resp.content : []).find((b) => b?.type === "tool_use" && b.name === name);
  return block?.input || {};
}

export const reviewState = (shop) => prisma.chatReviewState.findUnique({ where: { shop } });

// One read for a store: the unread settled chats, batched; findings kept;
// the watermark moved. `client` stands in for Anthropic in the tests.
export async function reviewChats(shop, { apiKey, client, model = DEFAULT_MODEL, now = new Date(), onProgress = () => {} } = {}) {
  const state = await reviewState(shop);
  const floor = new Date(now.getTime() - READ_BACK_DAYS * DAY_MS);
  const since = state?.reviewedThrough && state.reviewedThrough > floor ? state.reviewedThrough : floor;
  const rows = await prisma.chatRecording.findMany({
    where: { shop, createdAt: { gt: since } },
    select: { id: true, sessionId: true, tester: true, message: true, reply: true, products: true, ok: true, trashed: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 20000,
  });
  // The earlier turns of those chats, as context.
  const ids = [...new Set(rows.map((r) => r.sessionId))];
  const earlier = ids.length ? await prisma.chatRecording.findMany({
    where: { shop, sessionId: { in: ids.slice(0, 2000) }, createdAt: { lte: since } },
    select: { id: true, sessionId: true, tester: true, message: true, reply: true, products: true, ok: true, trashed: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 20000,
  }) : [];
  const { chats, through, left } = chatsToReview([...earlier, ...rows], { since, now });
  onProgress({ total: chats.length, done: 0 });
  const ai = client || new Anthropic({ apiKey, timeout: 120_000, maxRetries: 0 });
  const found = [];
  let read = 0;
  let firstError = null;
  for (const batch of reviewBatches(chats)) {
    try {
      const resp = await withAnthropicRetry(
        () => ai.messages.create({
          model,
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
          tools: [REVIEW_TOOL],
          tool_choice: { type: "tool", name: REVIEW_TOOL.name },
          messages: [{ role: "user", content: redactContactDetails(reviewPrompt(batch)) }],
        }),
        { label: "chat-review" },
      );
      found.push(...parseFindings(toolInput(resp, REVIEW_TOOL.name), batch));
      read += batch.length;
      onProgress({ total: chats.length, done: read });
    } catch (err) {
      // A batch that failed is read next time: the watermark stays before it.
      firstError = firstError || err;
      break;
    }
  }
  const readChats = chats.slice(0, read);
  const keptThrough = firstError
    ? (readChats.length ? new Date(Math.max(...readChats.map((c) => new Date(c.lastAt).getTime()))) : (state?.reviewedThrough || null))
    : through;
  if (found.length) {
    await prisma.chatReviewFinding.createMany({
      data: found.map((f) => ({ shop, sessionId: f.sessionId, recordingId: f.recordingId, tester: f.tester, subject: f.subject, problem: f.problem, note: redactContactDetails(f.note), better: redactContactDetails(f.better), message: redactContactDetails(f.message), reply: redactContactDetails(f.reply), at: new Date(f.at) })),
    });
  }
  const data = { reviewedThrough: keptThrough, lastRunAt: now, chats: read, findings: found.length };
  await prisma.chatReviewState.upsert({ where: { shop }, create: { shop, ...data }, update: data });
  if (read || found.length) console.log(`[chat-review] shop=${shop} chats=${read}/${chats.length} flagged=${found.length}${left ? ` left=${left}` : ""}${firstError ? ` error=${firstError?.message || firstError}` : ""}`);
  if (firstError && !read) throw firstError;
  return { read, flagged: found.length, left: left + (chats.length - read), partial: Boolean(firstError) };
}

// Lessons from the findings: a subject flagged MIN_REVIEW_FINDINGS times in
// the last REVIEW_LESSON_DAYS; a subject with a draft waiting (from either
// source) or decided in the last LESSON_REST_DAYS is left alone.
export async function draftReviewLessons(shop, { apiKey, client, model = DEFAULT_MODEL, now = new Date() } = {}) {
  const since = new Date(now.getTime() - REVIEW_LESSON_DAYS * DAY_MS);
  const rows = await prisma.chatReviewFinding.findMany({ where: { shop, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 500 });
  const groups = groupFindings(rows);
  if (!groups.length) return { drafted: [], skipped: [] };
  const rest = new Date(now.getTime() - LESSON_REST_DAYS * DAY_MS);
  const existing = await prisma.feedbackLesson.findMany({ where: { shop, OR: [{ status: "draft" }, { decidedAt: { gte: rest } }] }, select: { subject: true } });
  const busy = new Set(existing.map((l) => l.subject));
  const ai = client || new Anthropic({ apiKey, timeout: 90_000, maxRetries: 0 });
  const drafted = [];
  const skipped = [];
  for (const g of groups) {
    if (busy.has(g.subject)) { skipped.push(g.subject); continue; }
    const resp = await withAnthropicRetry(
      () => ai.messages.create({
        model,
        max_tokens: 700,
        system: LESSON_SYSTEM_PROMPT,
        tools: [LESSON_TOOL],
        tool_choice: { type: "tool", name: LESSON_TOOL.name },
        messages: [{ role: "user", content: redactContactDetails(findingsLessonPrompt(g)) }],
      }),
      { label: "chat-review-lessons" },
    );
    const parsed = parseLesson(toolInput(resp, LESSON_TOOL.name));
    if (!parsed) { skipped.push(g.subject); continue; }
    const examples = [];
    for (const r of g.rows) { const q = String(r.message || "").slice(0, 140); if (q && !examples.includes(q)) examples.push(q); if (examples.length >= 4) break; }
    drafted.push(await prisma.feedbackLesson.create({
      data: { shop, subject: g.subject, count: g.rows.length, lesson: parsed.lesson, kind: parsed.kind, fix: parsed.fix, examples, feedbackIds: g.rows.map((r) => r.id), status: "draft", source: "review" },
    }));
  }
  return { drafted, skipped };
}

// A read then the lessons, for one store.
async function reviewAndDraft(shop, opts) {
  const r = await reviewChats(shop, opts);
  const d = await draftReviewLessons(shop, opts);
  return { ...r, drafted: d.drafted.length };
}

// In-process runs, one per store at a time, so the page's "Review now" never
// stacks reads and the daily job waits for a run the page started.
const runs = new Map();
export function reviewRunState(shop) {
  const r = runs.get(shop);
  return r ? { running: r.running, total: r.total, done: r.done, error: r.error, result: r.result } : { running: false, total: 0, done: 0, error: "", result: null };
}
export function startReview(shop, { apiKey, client } = {}) {
  if ((!apiKey && !client) || runs.get(shop)?.running) return reviewRunState(shop);
  const state = { running: true, total: 0, done: 0, error: "", result: null };
  runs.set(shop, state);
  state.promise = reviewAndDraft(shop, { apiKey, client, onProgress: (p) => { state.total = p.total; state.done = p.done; } })
    .then((r) => { state.result = r; })
    .catch((err) => {
      console.error(`[chat-review] read failed shop=${shop}:`, err?.status || "", err?.message || err);
      state.error = err?.status === 401 ? "The AI key was refused. Check it in Settings." : "The chats couldn't be read right now. They'll be read next time.";
    })
    .finally(() => { state.running = false; });
  return reviewRunState(shop);
}
export async function settleReview(shop) { await runs.get(shop)?.promise; }

// On demand from the page, with the store's own key.
export async function reviewNow(shop) {
  const config = await getShopConfig(shop);
  if (!config?.anthropicApiKey) return { error: "Add the AI key in Settings first." };
  startReview(shop, { apiKey: config.anthropicApiKey });
  return { started: true };
}

// The daily run: every store with chats recorded in the window and an AI key.
export async function reviewAllChats() {
  const since = new Date(Date.now() - READ_BACK_DAYS * DAY_MS);
  const shops = await prisma.chatRecording.findMany({ where: { createdAt: { gte: since } }, distinct: ["shop"], select: { shop: true } });
  for (const { shop } of shops) {
    try {
      const config = await getShopConfig(shop);
      if (!config?.anthropicApiKey) continue;
      startReview(shop, { apiKey: config.anthropicApiKey });
      await settleReview(shop);
    } catch (err) {
      console.error(`[chat-review] daily read failed shop=${shop}:`, err?.message || err);
    }
  }
}

export async function cleanupOldFindings() {
  const cutoff = new Date(Date.now() - KEEP_FINDINGS_DAYS * DAY_MS);
  const out = await prisma.chatReviewFinding.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return out.count;
}

// The page: the last run and the latest findings (the newest first).
export async function reviewSummary(shop, { take = 20 } = {}) {
  const [state, rows] = await Promise.all([
    reviewState(shop),
    prisma.chatReviewFinding.findMany({ where: { shop }, orderBy: [{ createdAt: "desc" }, { at: "desc" }], take }),
  ]);
  return {
    state: state ? { reviewedThrough: state.reviewedThrough, lastRunAt: state.lastRunAt, chats: state.chats, findings: state.findings } : null,
    run: reviewRunState(shop),
    findings: rows.map((r) => ({
      id: r.id, sessionId: r.sessionId, tester: r.tester, subject: r.subject, label: FEEDBACK_SUBJECTS[r.subject] || r.subject,
      problem: r.problem, problemLabel: PROBLEMS[r.problem] || r.problem, note: r.note, better: r.better, message: r.message, reply: r.reply, at: r.at,
    })),
  };
}

// What the review found in the named chats, oldest first (the export).
export async function findingsForSessions(shop, sessionIds) {
  const ids = (sessionIds || []).slice(0, 2000);
  if (!ids.length) return [];
  return prisma.chatReviewFinding.findMany({ where: { shop, sessionId: { in: ids } }, orderBy: [{ at: "asc" }, { createdAt: "asc" }] });
}
