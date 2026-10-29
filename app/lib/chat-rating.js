// Shoppers' feedback: thumbs under an answer ("answer"), and the "How's
// the chat going?" check-in for the whole conversation ("chat") — asked
// after an add to cart, back from Buy now, or after a few replies — with a
// one-tap reason after a thumbs-down and an optional comment. Pure.

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

// Why, after a thumbs-down — the widget's one-tap reasons, as the admin
// names them.
export const FEEDBACK_REASONS = {
  wrong_product: "Wrong product",
  not_answered: "Didn't answer the question",
  wrong_info: "Info was wrong",
  too_slow: "Too slow",
  other: "Something else",
};
export function cleanReason(v) {
  return Object.prototype.hasOwnProperty.call(FEEDBACK_REASONS, v) ? v : null;
}

// When it was asked: an answer about an order, or (for the whole chat)
// after an add to cart, back from Buy now, or after a few replies.
export const FEEDBACK_MOMENTS = {
  order: "Order answer",
  cart: "After add to cart",
  buy_now: "After Buy now",
  replies: "After a few replies",
};
export function cleanMoment(v, kind = "answer") {
  if (kind === "chat") return ["cart", "buy_now", "replies"].includes(v) ? v : null;
  return v === "order" ? v : null;
}

// The widget's id for one vote (its reason, picked after, updates the
// same row).
export function cleanVoteKey(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}
