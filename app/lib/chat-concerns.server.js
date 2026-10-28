// What shoppers keep asking about — reading recorded shopper chats into
// themes (rules and prompts in chat-concerns.js). A read runs in the
// background, one per store at a time: (1) themes the new chats need, (2)
// which themes each chat raises, a batch of chats per call, (3) the top
// themes described from the chats behind them. Each chat is read once;
// counts are the chats stored against a theme, so they last after the
// recordings themselves are deleted. The page starts a read when it opens
// (at most every 30 minutes) or on Refresh; the daily clean-up reads what's
// left before recordings expire.
import Anthropic from "@anthropic-ai/sdk";
import prisma from "../db.server";
import { DEFAULT_MODEL } from "./claude-models.js";
import { withAnthropicRetry } from "./anthropic-resilience.server.js";
import { createLimiter } from "./concurrency.js";
import { groupSessions, KEEP_DAYS } from "./chat-recording.js";
import { redactContactDetails } from "../models/ChatFeedback.server";
import { getShopConfig } from "../models/ShopConfig.server";
import {
  SYSTEM_PROMPT, PROPOSE_TOOL, ASSIGN_TOOL, DESCRIBE_TOOL, MAX_THEMES, BATCH_SIZE, SAMPLE_CHATS, DESCRIBE_CHATS, TOP_COUNT, MORE_COUNT, AUTO_EVERY_MS,
  shopperSessions, pendingSessions, spread, themesPrompt, parseProposedThemes, assignPrompt, parseAssignments, describePrompt, parseDescription, needsDescribing, rankConcerns, pickQuote,
} from "./chat-concerns.js";

const runs = new Map(); // shop → { startedAt, total, done, error, finishedAt, running }
const generation = new Map(); // shop → n, bumped when the store's themes are reset
const lastAuto = new Map(); // shop → ms of the last read the page started by itself
const forgotten = new Map(); // shop → chats deleted while a read was running

const clean = (s) => redactContactDetails(String(s || ""));

export function concernRunState(shop) {
  const r = runs.get(shop);
  return r ? { running: Boolean(r.running), total: r.total, done: r.done, error: r.error || "", finishedAt: r.finishedAt || null } : { running: false, total: 0, done: 0, error: "", finishedAt: null };
}

// Every kept turn of the store's recordings, oldest first.
async function keptRows(shop) {
  const since = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
  return prisma.chatRecording.findMany({
    where: { shop, createdAt: { gte: since } },
    select: { id: true, sessionId: true, tester: true, message: true, reply: true, ok: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 20000,
  });
}

const getThemes = (shop) => prisma.chatConcern.findMany({ where: { shop }, orderBy: { createdAt: "asc" } });
const getLinks = (shop) => prisma.chatConcernChat.findMany({ where: { shop }, select: { sessionId: true, concernIds: true, quoteIds: true, lastTurnAt: true, createdAt: true, updatedAt: true } });

function toolInput(resp, name) {
  const block = (Array.isArray(resp?.content) ? resp.content : []).find((b) => b?.type === "tool_use" && b.name === name);
  if (!block) throw new Error("the model gave no answer");
  return block.input || {};
}

// Plain words for the page, never the raw API error.
export function readError(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 401 || status === 403) return "Claude refused the API key. Check it in Settings → API keys.";
  if (status === 429 || status === 529 || err?.code === "AI_BUSY") return "Claude is busy right now. Try again in a few minutes.";
  return "Couldn't read the chats just now. Try again.";
}

// One full read for a store. `client` stands in for Anthropic in the tests.
export async function readConcerns(shop, { apiKey, client, model = DEFAULT_MODEL, onProgress = () => {} } = {}) {
  const gen = generation.get(shop) || 0;
  const stale = () => (generation.get(shop) || 0) !== gen;
  // Chats deleted from here on aren't written back, even if this read
  // loaded them before they went.
  const gone = new Set();
  forgotten.set(shop, gone);
  const [rows, links, stored] = await Promise.all([keptRows(shop), getLinks(shop), getThemes(shop)]);
  const sessions = groupSessions(rows);
  const pending = pendingSessions(sessions, links).sort((a, b) => new Date(a.lastAt) - new Date(b.lastAt));
  onProgress({ total: pending.length, done: 0 });
  if (!pending.length) return { read: 0, themes: stored.length };
  // Kept chats read earlier that raised no theme: a need that comes up once
  // a day still becomes a theme (they're shown when finding themes), and
  // when new themes are added they're read again against them.
  const waiting = new Set(pending.map((s) => s.sessionId));
  const noTheme = new Set(links.filter((l) => !(l.concernIds || []).length).map((l) => l.sessionId));
  const unthemed = shopperSessions(sessions).filter((s) => noTheme.has(s.sessionId) && !waiting.has(s.sessionId));

  const ai = client || new Anthropic({ apiKey, timeout: 90_000, maxRetries: 0 });
  const ask = (prompt, tool, maxTokens) => withAnthropicRetry(
    () => ai.messages.create({
      model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: prompt }],
    }),
    { label: "concerns", maxRetries: 2, maxWaitMs: 30_000 },
  ).then((resp) => toolInput(resp, tool.name));

  // 1. Themes the new chats need.
  const themes = [...stored];
  let added = 0;
  if (themes.length < MAX_THEMES) {
    const sample = [...spread(pending, SAMPLE_CHATS), ...spread(unthemed, Math.floor(SAMPLE_CHATS / 2))];
    const proposed = parseProposedThemes(await ask(themesPrompt(themes, sample), PROPOSE_TOOL, 3000), themes);
    if (stale()) return { read: 0, stale: true };
    for (const t of proposed) {
      themes.push(await prisma.chatConcern.create({ data: { shop, title: clean(t.title), summary: clean(t.summary), kind: t.kind } }));
      added += 1;
    }
  }

  // 2. Which themes each chat raises — a few batches at a time. A batch that
  // fails is read again next time; the rest are kept.
  const toRead = added ? [...pending, ...unthemed] : pending;
  onProgress({ total: toRead.length, done: 0 });
  const limit = createLimiter(3);
  let done = 0;
  let read = 0;
  let firstError = null;
  const batches = [];
  for (let i = 0; i < toRead.length; i += BATCH_SIZE) batches.push(toRead.slice(i, i + BATCH_SIZE));
  await Promise.all(batches.map((batch) => limit.run(async () => {
    try {
      if (stale()) return;
      const answer = themes.length ? await ask(assignPrompt(themes, batch), ASSIGN_TOOL, 6000) : { chats: batch.map((_, i) => ({ chat: i + 1, themes: [] })) };
      if (stale()) return;
      const found = parseAssignments(answer, themes, batch).filter((f) => !gone.has(f.sessionId));
      await prisma.$transaction(found.map((f) => {
        const data = { concernIds: f.themes.map((t) => t.id), quoteIds: f.themes.map((t) => t.turnId), lastTurnAt: f.lastTurnAt };
        return prisma.chatConcernChat.upsert({ where: { shop_sessionId: { shop, sessionId: f.sessionId } }, create: { shop, sessionId: f.sessionId, ...data }, update: data });
      }));
      read += found.length;
    } catch (err) {
      firstError ||= err;
      console.error(`[concerns] batch failed shop=${shop}:`, err?.status || "", err?.message || err);
    } finally {
      done += batch.length;
      onProgress({ total: toRead.length, done });
    }
  }, { waitMs: 30 * 60 * 1000 })));
  if (stale()) return { read: 0, stale: true };
  if (!read && firstError) throw firstError;

  // 3. The top themes, described from their newest kept chats.
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const top = rankConcerns(themes, await getLinks(shop)).slice(0, TOP_COUNT);
  for (const t of top) {
    if (!needsDescribing(t, t.count)) continue;
    const kept = t.chats.map((c) => byId.get(c.sessionId)).filter(Boolean).slice(0, DESCRIBE_CHATS);
    if (!kept.length) continue;
    try {
      const d = parseDescription(await ask(describePrompt(t, kept), DESCRIBE_TOOL, 1000), t);
      if (stale()) break;
      await prisma.chatConcern.update({ where: { id: t.id }, data: { summary: clean(d.summary), lookAt: clean(d.lookAt), kind: d.kind, describedAt: t.count } });
    } catch (err) {
      console.error(`[concerns] describe failed shop=${shop}:`, err?.status || "", err?.message || err);
    }
  }
  console.log(`[concerns] read shop=${shop} chats=${read}/${toRead.length} new=${pending.length} themes=${themes.length} added=${added}`);
  return { read, pending: pending.length, themes: themes.length, added, partial: Boolean(firstError) };
}

// Starts a read in the background unless one is running. `auto` reads (the
// page opening) happen at most every AUTO_EVERY_MS per store.
export function startConcernRead(shop, { apiKey, auto = false, client } = {}) {
  const now = Date.now();
  if (!apiKey && !client) return concernRunState(shop);
  if (runs.get(shop)?.running) return concernRunState(shop);
  if (auto) {
    if (now - (lastAuto.get(shop) || 0) < AUTO_EVERY_MS) return concernRunState(shop);
    lastAuto.set(shop, now);
  }
  const state = { running: true, startedAt: now, total: 0, done: 0, error: "", finishedAt: null };
  runs.set(shop, state);
  state.promise = readConcerns(shop, { apiKey, client, onProgress: (p) => { state.total = p.total; state.done = p.done; } })
    .then((r) => {
      if (r?.partial) state.error = "Some chats couldn't be read. They'll be read next time.";
      return r;
    })
    .catch((err) => {
      console.error(`[concerns] read failed shop=${shop}:`, err?.status || "", err?.message || err);
      state.error = readError(err);
    })
    .finally(() => {
      state.running = false;
      state.finishedAt = new Date();
    });
  return concernRunState(shop);
}

// Waits for the store's running read, if any (the daily clean-up and tests).
export async function settleConcernRead(shop) {
  await runs.get(shop)?.promise;
}

// The card's data. `sessions` are the page's grouped recordings
// (groupSessions), used for the quotes and the chats still kept.
export async function concernSummary(shop, sessions = []) {
  const [themes, links] = await Promise.all([getThemes(shop), getLinks(shop)]);
  const ranked = rankConcerns(themes, links);
  const turnText = new Map();
  for (const s of sessions) for (const t of s.turns || []) turnText.set(t.id, t.message);
  const kept = new Set(sessions.map((s) => s.sessionId));
  const read = links.length;
  const shape = (t) => ({
    id: t.id,
    title: t.title,
    summary: t.summary,
    kind: t.kind,
    lookAt: t.lookAt,
    count: t.count,
    share: read ? t.count / read : 0,
    quote: pickQuote(t, turnText),
    sessionIds: t.chats.map((c) => c.sessionId).filter((id) => kept.has(id)),
  });
  const since = links.reduce((min, l) => (!min || new Date(l.createdAt) < min ? new Date(l.createdAt) : min), null);
  const updatedAt = links.reduce((max, l) => (!max || new Date(l.updatedAt) > max ? new Date(l.updatedAt) : max), null);
  return {
    read,
    since,
    updatedAt,
    top: ranked.slice(0, TOP_COUNT).map(shape),
    more: ranked.slice(TOP_COUNT, TOP_COUNT + MORE_COUNT).map(shape),
    pending: pendingSessions(sessions, links).length,
    run: concernRunState(shop),
  };
}

// A deleted chat no longer counts.
export async function forgetConcernChat(shop, sessionId) {
  const id = String(sessionId || "").slice(0, 80);
  if (!shop || !id) return 0;
  forgotten.get(shop)?.add(id);
  const { count } = await prisma.chatConcernChat.deleteMany({ where: { shop, sessionId: id } });
  return count;
}

// "Delete all": the themes start over. A read in progress stops writing.
export async function resetConcerns(shop) {
  generation.set(shop, (generation.get(shop) || 0) + 1);
  runs.delete(shop);
  lastAuto.delete(shop);
  await prisma.chatConcernChat.deleteMany({ where: { shop } });
  await prisma.chatConcern.deleteMany({ where: { shop } });
}

// Daily: every store's unread shopper chats, before recordings expire.
export async function readAllPendingConcerns() {
  const since = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
  const shops = await prisma.chatRecording.findMany({ where: { tester: "", createdAt: { gte: since } }, distinct: ["shop"], select: { shop: true } });
  for (const { shop } of shops) {
    try {
      const config = await getShopConfig(shop);
      if (!config?.anthropicApiKey) continue;
      startConcernRead(shop, { apiKey: config.anthropicApiKey });
      await settleConcernRead(shop);
    } catch (err) {
      console.error(`[concerns] daily read failed shop=${shop}:`, err?.message || err);
    }
  }
}
