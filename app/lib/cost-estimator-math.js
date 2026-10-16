// Cost estimator math — shared by the Analytics CostEstimator and its tests.
// Pure: no React, no DB.
//
// Monthly cost = sessions × share of visitors who chat × replies per chat ×
// cost per reply. Sessions come from the store's own Shopify Analytics; the
// cost per reply is measured from recorded replies once there are enough,
// otherwise priced from this store's real instructions and catalog
// (lean/cost-model.js).

export const CALC_MIN_SAMPLE = 25; // recorded replies before the measured average is trusted

export const DEFAULTS = {
  engagementPct: 2,   // AI shopping assistants typically see 1–3% of sessions start a chat
  repliesPerChat: 3,
};

// Recorded replies → the cost of a reply when the instructions are already
// cached ("warm"). A reply that wrote the instructions to cache (cold — test
// chats minutes apart, or a quiet night) is counted without that one-off
// write; monthlyEstimate adds it back at the rate real traffic would see.
export function warmAverage(rows = [], { prefixTokens = 0, coldStartExtra = 0 } = {}) {
  if (!rows.length) return { replies: 0, testReplies: 0, avgCost: 0, coldReplies: 0 };
  let total = 0;
  let cold = 0;
  for (const r of rows) {
    const isCold = prefixTokens > 0 && r.cacheWriteTokens >= prefixTokens * 0.9;
    if (isCold) cold += 1;
    total += Math.max(0, r.cost - (isCold ? coldStartExtra : 0));
  }
  return {
    replies: rows.length,
    testReplies: rows.filter((r) => r.internal).length,
    coldReplies: cold,
    avgCost: total / rows.length,
  };
}

// The per-reply rate in use, and where it came from.
export function resolvePerReply({ measured = null, modeled = null } = {}) {
  if (measured && measured.replies >= CALC_MIN_SAMPLE && measured.avgCost > 0) {
    return { perReply: measured.avgCost, source: "measured" };
  }
  if (modeled && modeled.perReply > 0) return { perReply: modeled.perReply, source: "modeled" };
  return { perReply: 0, source: "none" };
}

export const SOURCE_COPY = {
  measured: (n) => `Measured from ${n.toLocaleString("en-US")} real replies in the last 60 days (test chats included — same engine, same price).`,
  modeled: "Estimated from your store's actual instructions, catalog and search results. It switches to your measured cost after 25 replies — ask a few questions in the test chat on Home to measure it now.",
  none: "Add your AI engine key in Settings to estimate the cost per reply.",
};

// Share of replies that arrive after the 5-minute prompt cache expired,
// assuming chats spread over ~16 busy hours a day.
export function coldShare(monthlyReplies) {
  const perMinute = Math.max(0, monthlyReplies) / (30 * 16 * 60);
  return Math.exp(-perMinute * 5);
}

// perReply is a warm rate (modeled, or warmAverage); the cold-start share for
// this traffic level is added on top.
export function monthlyEstimate({ sessions, engagementPct, repliesPerChat, perReply, coldStartExtra = 0 }) {
  const chats = Math.max(0, sessions) * (Math.max(0, engagementPct) / 100);
  const replies = chats * Math.max(0, repliesPerChat);
  const rate = perReply + coldShare(replies) * coldStartExtra;
  return { chats, replies, rate, cost: replies * rate };
}

// rows: [{ month: "YYYY-MM", sessions }] from Shopify Analytics. Uses only
// complete months: the current month is partial, and so may be the first.
export function summarizeTraffic(rows = [], now = new Date()) {
  const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  let full = rows.filter((r) => r.month && r.month < current && r.sessions > 0).sort((a, b) => a.month.localeCompare(b.month));
  if (full.length > 12) full = full.slice(-12);
  if (full.length === 0) return { error: "no data" };
  const values = full.map((r) => r.sessions);
  const peak = full.reduce((a, b) => (b.sessions > a.sessions ? b : a));
  const low = full.reduce((a, b) => (b.sessions < a.sessions ? b : a));
  return {
    months: full,
    average: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    peak,
    low,
    yearTotal: values.reduce((a, b) => a + b, 0),
  };
}
