// Learn → Improve the website — the facts, the weekly draft and the page's
// actions (rules in site-ideas.js). The facts are what the app already
// counts: nothing is read from the chats afresh. Drafts wait on Analytics
// → Learn until the team marks each done or dismisses it.
import Anthropic from "@anthropic-ai/sdk";
import prisma from "../db.server";
import { DEFAULT_MODEL } from "./claude-models.js";
import { withAnthropicRetry } from "./anthropic-resilience.server.js";
import { getShopConfig } from "../models/ShopConfig.server";
import { getRecentQuestions, redactContactDetails } from "../models/ChatFeedback.server";
import { getTopProducts } from "../models/ChatProductMention.server";
import { getConversionSummary } from "../models/ChatConversion.server";
import { getTopicRows } from "../models/ChatTopic.server";
import { summarizeWeek } from "./weekly-summary";
import { rankConcerns } from "./chat-concerns.js";
import { FEEDBACK_REASONS, FEEDBACK_SUBJECTS } from "./chat-rating.js";
import { PROBLEMS } from "./chat-review.js";
import { SYSTEM_PROMPT, IDEAS_TOOL, IDEAS_DAYS, IDEAS_EVERY_DAYS, AREAS, IMPACT_WORDS, EFFORT_WORDS, ideasPrompt, parseIdeas, enoughFacts } from "./site-ideas.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Everything the draft rests on, for one store.
export async function gatherSiteFacts(shop, { days = IDEAS_DAYS, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * DAY_MS);
  const range = { startDate: since, endDate: now };
  const [themes, links, votes, findings, products, conversions, topics, chats] = await Promise.all([
    prisma.chatConcern.findMany({ where: { shop }, orderBy: { createdAt: "asc" } }),
    prisma.chatConcernChat.findMany({ where: { shop }, select: { sessionId: true, concernIds: true, quoteIds: true, lastTurnAt: true, createdAt: true, updatedAt: true } }),
    getRecentQuestions(shop, range, 300).catch(() => []),
    prisma.chatReviewFinding.findMany({ where: { shop, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 40 }),
    getTopProducts(shop, range, 10).catch(() => []),
    getConversionSummary(shop, range).catch(() => ({ count: 0, revenue: 0, currency: null })),
    getTopicRows(shop, { days }).catch(() => []),
    prisma.chatRecording.count({ where: { shop, trashed: false, createdAt: { gte: since } } }),
  ]);
  const ranked = rankConcerns(themes, links).slice(0, 10);
  // A shopper's own words for each theme, from the turns it was quoted on.
  const quoteIds = [...new Set(ranked.flatMap((t) => t.chats.slice(0, 6).map((c) => c.turnId).filter(Boolean)))];
  const turns = quoteIds.length ? await prisma.chatRecording.findMany({ where: { shop, id: { in: quoteIds } }, select: { id: true, message: true } }) : [];
  const text = new Map(turns.map((t) => [t.id, redactContactDetails(t.message)]));
  const themeFacts = ranked.map((t) => ({
    title: t.title, kind: t.kind, count: t.count, summary: t.summary, lookAt: t.lookAt,
    quotes: t.chats.map((c) => text.get(c.turnId)).filter((q) => q && q.split(" ").length >= 4).slice(0, 2),
  }));
  const downs = votes.filter((v) => v.vote === "down");
  const tally = (list, pick, labels) => {
    const by = {};
    for (const v of list) { const k = pick(v); if (k) by[k] = (by[k] || 0) + 1; }
    return Object.entries(by).map(([k, count]) => ({ label: labels[k] || k, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  const week = summarizeWeek(topics, { all: true });
  return {
    days,
    chats,
    conversions,
    themes: themeFacts,
    unanswered: week.unanswered.slice(0, 10),
    storeQuestions: week.storeQuestions.slice(0, 8),
    conditions: week.conditions.slice(0, 8),
    supportHandoffs: week.supportHandoffs,
    downs: {
      total: downs.length,
      bySubject: tally(downs, (v) => (FEEDBACK_SUBJECTS[v.subject] ? v.subject : "other"), FEEDBACK_SUBJECTS),
      byReason: tally(downs, (v) => (v.reason && FEEDBACK_REASONS[v.reason] ? v.reason : ""), FEEDBACK_REASONS),
      comments: votes.map((v) => v.comment).filter(Boolean).map((c) => redactContactDetails(c)).slice(0, 8),
    },
    findings: findings.map((f) => ({ subject: FEEDBACK_SUBJECTS[f.subject] || f.subject, problem: PROBLEMS[f.problem] || f.problem, note: f.note, better: f.better })),
    products: products.map((p) => ({ title: p.title, count: p.mentions })),
  };
}

function toolInput(resp) {
  const block = (Array.isArray(resp?.content) ? resp.content : []).find((b) => b?.type === "tool_use" && b.name === IDEAS_TOOL.name);
  return block?.input || {};
}

// A draft for one store: the facts, the model, the ideas kept (a repeat of
// an open idea's title is not). `client` stands in for Anthropic in tests.
export async function draftSiteIdeas(shop, { apiKey, client, model = DEFAULT_MODEL, now = new Date() } = {}) {
  const facts = await gatherSiteFacts(shop, { now });
  if (!enoughFacts(facts)) return { drafted: [], thin: true };
  const open = await prisma.siteIdea.findMany({ where: { shop, status: "open" }, select: { title: true } });
  const ai = client || new Anthropic({ apiKey, timeout: 120_000, maxRetries: 0 });
  const resp = await withAnthropicRetry(
    () => ai.messages.create({
      model,
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      tools: [IDEAS_TOOL],
      tool_choice: { type: "tool", name: IDEAS_TOOL.name },
      messages: [{ role: "user", content: ideasPrompt(facts) }],
    }),
    { label: "site-ideas" },
  );
  const quotes = [...facts.themes.flatMap((t) => t.quotes), ...facts.downs.comments];
  const ideas = parseIdeas(toolInput(resp), { taken: open.map((o) => o.title), quotes });
  const drafted = [];
  for (const i of ideas) drafted.push(await prisma.siteIdea.create({ data: { shop, ...i } }));
  if (drafted.length) console.log(`[site-ideas] shop=${shop} drafted=${drafted.length}`);
  return { drafted, thin: false };
}

// Weekly: every store with recordings and an AI key whose last draft is a
// week old (or that never had one).
export async function draftAllSiteIdeas() {
  const since = new Date(Date.now() - IDEAS_DAYS * DAY_MS);
  const shops = await prisma.chatRecording.findMany({ where: { createdAt: { gte: since } }, distinct: ["shop"], select: { shop: true } });
  const due = new Date(Date.now() - IDEAS_EVERY_DAYS * DAY_MS);
  for (const { shop } of shops) {
    try {
      const config = await getShopConfig(shop);
      if (!config?.anthropicApiKey) continue;
      const last = await prisma.siteIdea.findFirst({ where: { shop }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      if (last && last.createdAt > due) continue;
      await draftSiteIdeas(shop, { apiKey: config.anthropicApiKey });
    } catch (err) {
      console.error(`[site-ideas] ${shop}: ${err?.message || err}`);
    }
  }
}

// On demand from the page, with the store's own key.
export async function draftSiteIdeasNow(shop) {
  const config = await getShopConfig(shop);
  if (!config?.anthropicApiKey) return { error: "Add the AI key in Settings first." };
  const r = await draftSiteIdeas(shop, { apiKey: config.anthropicApiKey });
  return { drafted: r.drafted.length, thin: r.thin };
}

const shape = (i) => ({
  id: i.id, title: i.title, area: i.area, areaLabel: AREAS[i.area] || AREAS.other, change: i.change, why: i.why, evidence: i.evidence || [],
  impact: i.impact, impactLabel: IMPACT_WORDS[i.impact] || IMPACT_WORDS.medium, effort: i.effort, effortLabel: EFFORT_WORDS[i.effort] || EFFORT_WORDS.medium,
  shoppers: i.shoppers, priority: i.priority, status: i.status, createdAt: i.createdAt, decidedAt: i.decidedAt,
});

// The page: open ideas best first, and the last few decided.
export async function listSiteIdeas(shop) {
  const [open, decided, last] = await Promise.all([
    prisma.siteIdea.findMany({ where: { shop, status: "open" }, orderBy: [{ priority: "desc" }, { createdAt: "desc" }], take: 20 }),
    prisma.siteIdea.findMany({ where: { shop, status: { in: ["done", "dismissed"] } }, orderBy: [{ decidedAt: "desc" }], take: 8 }),
    prisma.siteIdea.findFirst({ where: { shop }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  return { open: open.map(shape), decided: decided.map(shape), lastDraftAt: last?.createdAt || null };
}

export async function decideSiteIdea(shop, id, decision) {
  const idea = await prisma.siteIdea.findFirst({ where: { id, shop } });
  if (!idea) return { error: "That idea is gone." };
  if (idea.status !== "open") return { error: "Already decided." };
  if (decision !== "done" && decision !== "dismissed") return { error: "Unknown decision." };
  await prisma.siteIdea.update({ where: { id }, data: { status: decision, decidedAt: new Date() } });
  return { ok: true, decision };
}
