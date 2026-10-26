import prisma from "../db.server";
import { dayKeyIn, dayKeysBetween } from "../lib/store-day.js";
import { computeCost } from "../lib/pricing.server";
import { summarizeUsageRecords } from "../lib/usage-summary.js";

export { summarizeUsageRecords };

// UTC midnight keeps the cap consistent across server instances and matches
// how Shopify reports day boundaries in the admin.
function startOfTodayUtc() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function getTodayMessageCount(shop) {
  return prisma.chatUsage.count({
    where: { shop, internal: false, createdAt: { gte: startOfTodayUtc() } },
  });
}

export async function recordChatUsage({ shop, model, usage, toolCalls, embeddingTokens = 0, embeddingCostUsd = 0, internal = false, checks = null }) {
  // The engine's quick yes/no checks run on a cheaper model: priced as that
  // model and added to the turn's cost (the token columns stay the chat model's).
  const costUsd = computeCost(model, usage) + (checks ? computeCost(checks.model, checks.usage) : 0);
  return prisma.chatUsage.create({
    data: {
      shop,
      model,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
      cacheReadInputTokens: usage.cache_read_input_tokens || 0,
      costUsd,
      toolCalls: toolCalls || 0,
      // Semantic-search (embedding) spend for this turn — kept in its
      // own columns so the Anthropic-only figure stays queryable, but
      // folded into every summary total downstream.
      embeddingTokens: embeddingTokens || 0,
      embeddingCostUsd: embeddingCostUsd || 0,
      internal: Boolean(internal),
    },
  });
}

// "Visualize My Look" image generation. Recorded as its own usage row
// (model = "image:<provider>") so it folds into spend totals without
// polluting the per-Anthropic-model token math.
export async function recordImageUsage({ shop, provider, costUsd = 0 }) {
  return prisma.chatUsage.create({
    data: {
      shop,
      model: `image:${provider || "unknown"}`,
      costUsd: 0,
      imageCount: 1,
      imageCostUsd: Number(costUsd) || 0,
    },
  });
}

function resolveRange(arg) {
  if (arg instanceof Date || typeof arg === "string") {
    const start = arg instanceof Date ? arg : new Date(arg);
    return { start, end: new Date() };
  }
  if (arg && typeof arg === "object") {
    if (arg.startDate && arg.endDate) {
      return { start: new Date(arg.startDate), end: new Date(arg.endDate) };
    }
    if (typeof arg.days === "number") {
      const start = new Date();
      start.setDate(start.getDate() - arg.days);
      return { start, end: new Date() };
    }
  }
  if (typeof arg === "number") {
    const start = new Date();
    start.setDate(start.getDate() - arg);
    return { start, end: new Date() };
  }
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return { start, end: new Date() };
}

// The dashboards read every chat row in their range. On a busy day staff
// refresh them often on the same server that answers shoppers, so each
// result is kept for a minute and only the columns the summaries use are read.
const SUMMARY_TTL_MS = 60_000;
const summaryCache = new Map(); // key → { at, value }
function cachedSummary(key, compute) {
  const hit = summaryCache.get(key);
  if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return hit.value;
  const value = compute();
  summaryCache.set(key, { at: Date.now(), value });
  value.catch(() => summaryCache.delete(key));
  if (summaryCache.size > 200) summaryCache.delete(summaryCache.keys().next().value);
  return value;
}

const SUMMARY_COLUMNS = { createdAt: true, model: true, inputTokens: true, outputTokens: true, toolCalls: true, costUsd: true, embeddingCostUsd: true, imageCostUsd: true, imageCount: true };

export function getUsageSummary(shop, range = 30) {
  return cachedSummary(`usage|${shop}|${JSON.stringify(range)}`, async () => {
    const { start, end } = resolveRange(range);
    const records = await prisma.chatUsage.findMany({
      where: { shop, internal: false, createdAt: { gte: start, lte: end } },
      select: SUMMARY_COLUMNS,
      orderBy: { createdAt: "desc" },
    });
    return summarizeUsageRecords(records, start.toISOString(), end.toISOString());
  });
}

export function getDailySeries(shop, range = 30, { timeZone = "" } = {}) {
  return cachedSummary(`daily|${shop}|${JSON.stringify(range)}|${timeZone}`, () => dailySeries(shop, range, { timeZone }));
}

async function dailySeries(shop, range, { timeZone }) {
  const dayKey = dayKeyIn(timeZone);
  const { start, end } = resolveRange(range);
  const [usageRows, feedbackRows] = await Promise.all([
    prisma.chatUsage.findMany({
      where: { shop, internal: false, createdAt: { gte: start, lte: end } },
      select: { createdAt: true, costUsd: true, embeddingCostUsd: true, imageCostUsd: true, model: true, inputTokens: true, outputTokens: true, toolCalls: true },
    }),
    prisma.chatFeedback.findMany({
      where: { shop, createdAt: { gte: start, lte: end } },
      select: { createdAt: true, vote: true },
    }),
  ]);

  const map = new Map();
  for (const key of dayKeysBetween(start, end, dayKey)) {
    map.set(key, { date: key, messages: 0, cost: 0, tokens: 0, toolCalls: 0, up: 0, down: 0 });
  }
  for (const r of usageRows) {
    const key = dayKey(r.createdAt);
    const row = map.get(key);
    if (!row) continue;
    // Image-styling rows add cost but aren't messages (see getUsageSummary).
    if (typeof r.model === "string" && r.model.startsWith("image:")) {
      row.cost += r.imageCostUsd || 0;
      continue;
    }
    row.messages += 1;
    row.cost += (r.costUsd || 0) + (r.embeddingCostUsd || 0);
    row.tokens += (r.inputTokens || 0) + (r.outputTokens || 0);
    row.toolCalls += r.toolCalls || 0;
  }
  for (const r of feedbackRows) {
    const key = dayKey(r.createdAt);
    const row = map.get(key);
    if (!row) continue;
    if (r.vote === "up") row.up += 1;
    else if (r.vote === "down") row.down += 1;
  }

  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// What replies have really cost — customer chats and admin test chats alike
// (same engine, same price). Feeds the cost estimate.
export async function getReplyCostSample(shop, { days = 60 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.chatUsage.findMany({
    where: { shop, createdAt: { gte: since }, NOT: { model: { startsWith: "image:" } } },
    select: { costUsd: true, embeddingCostUsd: true, internal: true, model: true, cacheCreationInputTokens: true },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
  return rows.map((r) => ({
    cost: (r.costUsd || 0) + (r.embeddingCostUsd || 0),
    cacheWriteTokens: r.cacheCreationInputTokens || 0,
    internal: r.internal,
    model: r.model,
  }));
}

// Usage rows older than ~13 months (a year of analytics plus margin).
export async function cleanupOldUsage() {
  const cutoff = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  try {
    await prisma.chatUsage.deleteMany({ where: { createdAt: { lt: cutoff } } });
  } catch (err) {
    console.error("[ChatUsage] cleanup error:", err?.message);
  }
}
