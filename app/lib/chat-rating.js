// "How's the chat going?" — a quiet check-in after a few replies: thumbs up
// or down for the whole conversation, with an optional comment. Pure.

export const CHAT_RATING_AFTER = { min: 2, max: 8, fallback: 3 };
export const COMMENT_MAX = 500;

// What the widget needs: whether to ask, and after how many replies.
export function chatRatingConfig(config = {}) {
  const n = Math.round(Number(config.chatRatingAfter));
  const after = Number.isFinite(n) ? Math.min(CHAT_RATING_AFTER.max, Math.max(CHAT_RATING_AFTER.min, n)) : CHAT_RATING_AFTER.fallback;
  return { on: config.chatRatingOn !== false, after };
}

// The shopper's comment as stored: one paragraph, no control characters.
export function cleanComment(text) {
  return [...String(text ?? "")]
    .map((ch) => { const c = ch.charCodeAt(0); return c < 32 || c === 127 ? " " : ch; })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, COMMENT_MAX);
}
