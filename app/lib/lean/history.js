// Lean engine — the conversation as the widget sends it. Pure.

// Inbound history from the widget: drop stray role markers, and note which
// product cards were shown under each assistant reply so "the second one"
// and follow-ups about shown products resolve.
export function sanitizeHistory(history) {
  const out = [];
  for (const turn of Array.isArray(history) ? history : []) {
    if (!turn?.role || !turn?.content) continue;
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    let content = String(turn.content).replace(/^\s*(?:Human|Assistant)\s*:\s*/i, "");
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
  return out;
}
