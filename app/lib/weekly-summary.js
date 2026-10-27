// Analytics "This week" summary — what customers asked about, from the
// ChatTopic rows the chat engine records each turn. Pure.

const TOOL_LABELS = {
  get_customer_orders: "Order status",
  get_my_orders: "Order status",
  get_fit_recommendation: "Size / fit help",
  get_product_reviews: "Reviews",
  show_newsletter_signup: "Newsletter signup",
  show_which_orthotic_quiz: "Which orthotic do I have",
  show_store_locator: "Store locator",
};

const label = (v) => String(v || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function top(rows, kind, limit, fmt = label) {
  const counts = new Map();
  for (const r of rows) {
    if (r.kind !== kind) continue;
    const key = String(r.value || "").trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ label: fmt(value), count }));
}

// `all`: every topic, not just the top few (the CSV export).
export function summarizeWeek(rows = [], { all = false } = {}) {
  const n = (limit) => (all ? Infinity : limit);
  const count = (kind) => rows.filter((r) => r.kind === kind).length;
  const tools = top(rows, "tool", n(6), (v) => TOOL_LABELS[v] || (v.startsWith("recommend") ? "Guided finder" : label(v)));
  const merged = new Map();
  for (const t of tools) merged.set(t.label, (merged.get(t.label) || 0) + t.count);
  return {
    categories: top(rows, "category", n(5)),
    conditions: top(rows, "condition", n(5)),
    colors: top(rows, "color", n(5)),
    products: top(rows, "product", n(5), (v) => v.replace(/\b\w/g, (c) => c.toUpperCase())),
    storeQuestions: top(rows, "store_question", n(5), (v) => v.charAt(0).toUpperCase() + v.slice(1)),
    unanswered: top(rows, "unanswered", n(8), (v) => v.charAt(0).toUpperCase() + v.slice(1)),
    supportHandoffs: count("support"),
    saleSearches: count("sale"),
    tools: [...merged.entries()].map(([l, c]) => ({ label: l, count: c })).sort((a, b) => b.count - a.count),
    empty: rows.length === 0,
  };
}
