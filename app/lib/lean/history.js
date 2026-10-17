// Lean engine — the conversation as the widget sends it. Pure.

// The history comes from the browser, so it's bounded here: every turn is
// resent to the model on every step, and an oversized history would be
// billed to the store.
export const HISTORY_MAX_TURNS = 20;
export const HISTORY_MAX_TURN_CHARS = 3000;
export const HISTORY_MAX_TOTAL_CHARS = 24000;

// Inbound history from the widget: drop stray role markers, and note which
// product cards were shown under each assistant reply so "the second one"
// and follow-ups about shown products resolve. Keeps the most recent turns
// that fit the limits above.
export function sanitizeHistory(history) {
  const out = [];
  const turns = Array.isArray(history) ? history.slice(-HISTORY_MAX_TURNS) : [];
  for (const turn of turns) {
    if (!turn?.role || !turn?.content) continue;
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    let content = String(turn.content).slice(0, HISTORY_MAX_TURN_CHARS).replace(/^\s*(?:Human|Assistant)\s*:\s*/i, "");
    content = content.replace(/\n\s*(?:Human|Assistant)\s*:\s*/gi, "\n");
    if (turn.role === "assistant" && Array.isArray(turn.products) && turn.products.length > 0) {
      const shown = turn.products
        .slice(0, 10)
        .map((p, i) => {
          const title = String(p?.title || "").trim();
          if (!title) return null;
          const price = String(p?.price_formatted || p?.price || "").trim();
          return `${i + 1}. ${title}${price ? ` (${price})` : ""}`;
        })
        .filter(Boolean);
      if (shown.length > 0) content += `\n\n[Product cards displayed with this reply: ${shown.join("; ")}]`;
    }
    out.push({ role: turn.role, content });
  }
  let total = out.reduce((n, t) => n + t.content.length, 0);
  while (out.length && total > HISTORY_MAX_TOTAL_CHARS) total -= out.shift().content.length;
  return out;
}

// The widget's history may already end with the message being sent; the
// route adds it once, so a trailing copy is dropped.
export function withoutTrailingCopy(history, message) {
  const last = history[history.length - 1];
  if (last?.role === "user" && last.content.trim() === String(message).trim()) return history.slice(0, -1);
  return history;
}
