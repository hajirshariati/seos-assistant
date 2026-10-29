// Analytics CSV rows that aren't a plain list: the range's numbers in one
// file (everything the page leaves off), and the week's topics. Pure.
import { FEEDBACK_REASONS } from "./chat-rating.js";

export const MODEL_LABELS = {
  "claude-sonnet-4-20250514": "Standard",
  "claude-sonnet-4-6": "Standard",
  "claude-haiku-4-5-20251001": "Fast",
  "claude-haiku-4-5": "Fast",
  "claude-opus-4-20250514": "Advanced",
  "claude-opus-4-6": "Advanced",
  "claude-opus-4-7": "Advanced",
  "claude-opus-4-8": "Advanced",
};
export const modelLabel = (m) => MODEL_LABELS[m] || m;

const usd = (n) => (Number(n) || 0).toFixed(4);
const money = (n) => (Number(n) || 0).toFixed(2);

// [Metric, Value, Notes] for the chosen range.
export function summaryRows({ range, usage = {}, feedback = {}, conversions = {}, interest = {}, daily = [] }) {
  const activeDays = daily.filter((d) => d.messages > 0).length;
  const currency = conversions.currency || "USD";
  return [
    ["From", range?.startDate ? new Date(range.startDate).toISOString().slice(0, 10) : "", ""],
    ["To", range?.endDate ? new Date(range.endDate).toISOString().slice(0, 10) : "", ""],
    ["Conversations", usage.totalMessages || 0, "Assistant replies"],
    ["Chat-driven orders", conversions.count || 0, "Orders credited to the chat"],
    [`Chat-driven revenue (${currency})`, money(conversions.revenue), ""],
    [`Average order value (${currency})`, money(conversions.aov), ""],
    ["Satisfaction (%)", feedback.total > 0 ? feedback.satisfactionRate : "", feedback.total > 0 ? "" : "No votes yet"],
    ["Helpful votes", feedback.up || 0, ""],
    ["Not helpful votes", feedback.down || 0, ""],
    // Why, from the one-tap reasons after a thumbs-down.
    ...Object.entries(FEEDBACK_REASONS).map(([key, label]) => [`Not helpful: ${label}`, feedback.reasons?.[key] || 0, "Reason picked"]),
    ["AI cost (USD)", usd(usage.totalCost), "Everything below included"],
    ["Average cost per conversation (USD)", usd(usage.avgCostPerMessage), ""],
    ["Semantic search cost (USD)", usd(usage.embeddingCost), ""],
    ["See It Styled images", usage.imageCount || 0, ""],
    ["See It Styled cost (USD)", usd(usage.imageCost), ""],
    ["AI actions", usage.totalToolCalls || 0, "Searches and lookups"],
    ["Products found", interest.searches || 0, "Returned by catalog searches"],
    ["Product details opened", interest.views || 0, "Sizes, colors, specifics asked"],
    ["Product cards shown", interest.shown || 0, "Recommended to customers"],
    ["Input tokens", usage.totalInputTokens || 0, "Sent to the AI"],
    ["Output tokens", usage.totalOutputTokens || 0, "Written by the AI"],
    ["Active days", `${activeDays} of ${daily.length}`, ""],
  ];
}

// [List, Topic, Count] from summarizeWeek(rows, { all: true }).
export function topicRows(week = {}) {
  const lists = [
    ["Couldn't answer from your store info", week.unanswered],
    ["Shopping for", week.categories],
    ["Foot conditions", week.conditions],
    ["Colors", week.colors],
    ["Store questions", week.storeQuestions],
    ["Products asked about", week.products],
    ["Also used", week.tools],
  ];
  const rows = [];
  for (const [name, items] of lists) for (const t of items || []) rows.push([name, t.label, t.count]);
  rows.push(["Totals", "Sent to customer service", week.supportHandoffs || 0]);
  rows.push(["Totals", "Sale searches", week.saleSearches || 0]);
  return rows;
}
