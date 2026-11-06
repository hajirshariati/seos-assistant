// Engagement: of the store's online sessions (Shopify Analytics), the share
// in which the shopper sent AVA a message. Chats come from the per-chat log
// (one row per chat, from its first message; a "Talk to a person" tap with
// no message isn't a chat); sessions from ShopifyQL, day by day in the
// store's time zone. Pure maths here — the loader brings the two counts.

// Percent to one decimal, or null when there's nothing to divide by.
export function rateOf(chats, sessions) {
  const c = Number(chats) || 0, s = Number(sessions) || 0;
  if (s <= 0) return null;
  return Math.round((c / s) * 1000) / 10;
}

// ShopifyQL rows ({ day: "2026-10-29…", sessions: "23673" }) → { "2026-10-29": 23673 }.
export function sessionsByDayFrom(rows = []) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const key = String(r?.day ?? r?.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    out[key] = (out[key] || 0) + (Number(r.sessions) || 0);
  }
  return out;
}

// The days of a range with their chats, sessions and rate, and the totals.
// `sessionsByDay` null means Shopify's counts weren't available: every rate
// is null and the totals say so.
export function engagementSeries(dayKeys = [], chatsByDay = {}, sessionsByDay = null) {
  const have = sessionsByDay && typeof sessionsByDay === "object";
  let chats = 0, sessions = 0;
  const days = dayKeys.map((date) => {
    const c = Number(chatsByDay?.[date]) || 0;
    const s = have ? Number(sessionsByDay[date]) || 0 : null;
    chats += c;
    if (s) sessions += s;
    return { date, chats: c, sessions: s, rate: have ? rateOf(c, s) : null };
  });
  return { days, chats, sessions: have ? sessions : null, rate: have ? rateOf(chats, sessions) : null };
}

// What the page says when there's no rate: the permission the store hasn't
// granted, or Shopify simply not answering.
export function engagementNote(error) {
  if (!error) return "";
  if (error === "permission") return "Needs Shopify's reports permission to count the store's sessions — reinstall the app to grant it.";
  return "Shopify's session counts aren't available right now; the chats are counted all the same.";
}
